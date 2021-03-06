/*jshint laxcomma: true, smarttabs: true, node:true, esnext:true, unused: true*/
'use strict';
/**
 * Manage Timers on a node
 * @module skyring/lib/timer
 * @author Eric Satterwhite
 * @since 3.0.0
 * @requires debug
 * @requires skyring/lib/transports
 * @requires skyring/lib/nats
 * @requires skyring/lib/json
 */
const os             = require('os')
    , crypto         = require('crypto')
    , path           = require('path')
    , levelup        = require('levelup')
    , encode         = require('encoding-down')
    , Transports     = require('./transports')
    , nats           = require('./nats')
    , json           = require('./json')
    , conf           = require('../conf')
    , debug          = require('debug')('skyring:timer')
    , rebalance      = require('debug')('skyring:rebalance')
    , store          = require('debug')('skyring:store')
    , storage        = Symbol('storage')
    , shutdown       = Symbol.for('kShutdown')
    , kNode          = Symbol('nodeid')
    , kRemove        = Symbol('remove')
    , noop           = () => {}
    ;


const EVENT_STATUS = {
  CREATED:   'create'
, UPDATED:   'replace'
, EXEC:      'execute'
, CANCELLED: 'cancel'
, FAIL:      'fail'
, SUCCESS:   'success'
, SHUTDOWN:  'shutdown'
, READY:     'ready'
, RECOVERY:  'recover'
, REBALANCE: 'rebalance'
, PURGE:     'purge'
, EVICT:     'evict'
}

function generateId(id) {
  if (!id) return crypto.randomBytes(10).toString('hex')
  return crypto.createHash('sha1').update(id).digest('hex')
}
/**
 * Node style callback
 * @typedef {Function} Nodeback
 * @property {?Error} [err] An error instance. If not null, the results should not be trusted
 * @property {Object} result The results of the function execution
 **/

/**
 * @constructor
 * @alias module:skyring/lib/timer
 * @param {Object} [options]
 * @param {Object} [options.nats] Nats connection information
 * @param {String[]} [options.nats.servers] A list of nats `host:port` to connect to
 * @param {Object} [options.storage] Storage config options for level db
 * @param {String[]} [options.storage.backend=memdown] a requireable module name, or absolute path to a leveldb compatible backend. `memdown` and `leveldown` are built in
 * `leveldown` and `memdown` are installed by default
 * @param {String} options.storage.path A directory path to a leveldb instance. One will be created if it doesn't already exist.
 * If the backend is memdown, this is optional and randomly generated per timer instance
 * @param {Function} [onReady=()=>{}] A callback function to call after initial recovery has completed
 * @param {String[]|Function[]} [options.transports] an array of custom transport functions, or requireable paths that resolve to functions. All transport function must be named functions
 * If not specified, configuration values will be used
 **/
class Timer extends Map {
  constructor(options = {}, cb = () => {}) {
    super();
    this.options = Object.assign({}, {
      nats: null
    , storage: null
    , transports: []
    }, options);
    this._sid = null;
    this._bail = false;
    const store_opts = conf.get('storage');
    const opts = Object.assign(store_opts, this.options.storage);
    store(opts);
    if (!opts.path) {
      if (opts.backend === 'memdown') {
        this[kNode] = generateId()
        opts.path = path.join(
          os.tmpdir()
        , `skyring-${this[kNode]}`
        );
      } else {
        const err = new Error('storage.path must be set with non memdown backends');
        err.code = 'ENOSTORAGE';
        throw err;
      }
    }
    const backend = opts.backend === 'memdown'
      ? new (require(opts.backend))
      : encode(require(opts.backend)(opts.path), {valueEncoding: 'json'})

    debug('storage path', opts);
    this[kNode] = generateId(store_opts.path)
    this.nats = nats.createClient( this.options.nats );
    this.transports = new Transports(this.options.transports);
    this[storage] = levelup(backend, opts, (err) => {
      store('storage backend ready', store_opts);
      debug('node id', this[kNode])
      this.recover(() => {
        this.nats.publish('skyring:node', JSON.stringify({
          node: this[kNode]
        , type: EVENT_STATUS.READY
        }), cb)
      });
    })

  }

  /**
   * Sets a new time instance. If The timer has lapsed, it will be executed immediately
   * @method module:skyring/lib/timer#create
   * @param {String} id A unique Id of the time
   * @param {Object} body Configuration options for the timer instance
   * @param {Number} body.timeout the time in milliseconds from now the timer should execute. This must be in the range: 0 < timeout < 2^31 - 1.
   * @param {String} body.data The data to be assicated with the timer, when it is executed
   * @param {Number} [body.created=Date.now()] timestamp when the timer is created. if not set, will default to now
   * @param {Object} callback Options for the outbound transport for the timer when it executes
   * @param {String} callback.transport The transport type ( http, etc )
   * @param {String} transport.method The method the transport should use when executing the timer
   * @param {String} transport.uri The target uri for the transport when the timer executes
   * @param {Nodeback} callback
   * @example
const crypto = require('crypto')
id = crypto.createHash('sha1')
           .update(crypto.randomBytes(10))
           .digest('hex')

const options = {
  timeout: 4000
, data: "this is a payload"
, callback: {
    transport: 'http'
  , method: 'put'
  , uri: 'http://api.domain.com/callback'
  }
}

timers.create(id, options, (err) => {
  if (err) throw err
})
   **/
  create(id, body, cb) {
    const payload = body;
    const transport = this.transports[payload.callback.transport];
    if (!transport) {
      const err = new Error(`Unknown transport ${payload.callback.transport}`)
      err.code = 'ENOTRANSPORT'
      return setImmediate(cb, err)
    }
    if ( this.has( id ) ) {
      const err = new Error(`Timer with id ${id} already exists` );
      err.code = 'EKEYEXISTS';
      return setImmediate(cb, err);
    }
    const now = Date.now();
    const created = payload.created || now;
    const elapsed = now - created;
    if( now > created + payload.timeout ){
      debug('executing stale timer');
      setImmediate(
        transport
      , payload.callback.method
      , payload.callback.uri
      , payload.data
      , id
      , this
      );

      this.nats.publish('skyring:events', JSON.stringify({
        type: EVENT_STATUS.EXEC
      , timer: id
      , node: this[kNode]
      , executed: Date.now()
      , created: created
      , payload: payload
      }), noop);

      return cb(null, id);
    }

    const data = {
      created: Date.now()
    , id: id
    , payload: payload
    , timer: null
    };

    this[storage].put(id, data, (err) => {
      debug('setting timer', id);
      //TODO(esatterwhite):
      // what should happen if leveldb fails.
      if (err) console.error(err);
      this.nats.publish('skyring:events', JSON.stringify({
        type: EVENT_STATUS.CREATED
      , timer: id
      , node: this[kNode]
      , created: data.created
      , payload: payload
      }), noop);

      data.timer = setTimeout(
        transport
      , payload.timeout - elapsed
      , payload.callback.method
      , payload.callback.uri
      , payload.data
      , id
      , this
      ).unref();
      this.set( id, data );
      cb(null, id);
    });
  }

  /**
   * Clears the respective timer from storage and publishes a success event via nats
   * @method module:skyring/lib/timer#success
   * @param {String} id the is of the time to acknowledge as delivered successfully
   * @param {Nodeback} [callback] Callback to execute when the acknowledge is complete
   * @example timers.success('2e2f6dad-9678-4caf-bc41-8e62ca07d551')
   **/
  success(id, cb = noop) {
    this[kRemove](id, (err) => {
      this.nats.publish('skyring:events', JSON.stringify({
        type: EVENT_STATUS.SUCCESS
      , timer: id
      , node: this[kNode]
      }), cb)
    })
  }

  /**
   * Clears the respective timer from storage and publishes a failure event via nats
   * @method module:skyring/lib/timer#failure
   * @param {String} id the is of the time to acknowledge as delivered successfully
   * @param {Error} error The error object to send with event objects
   * @param {Nodeback} [callback] Callback to execute when the acknowledge is complete
   * @example
const error = Error('Remote server unavailable')
error.code = 'ENOREMOTE'
timers.success('2e2f6dad-9678-4caf-bc41-8e62ca07d551', error)
   **/
  failure(id, error, cb = noop) {
    this[kRemove](id, (err) => {
      this.nats.publish('skyring:events', JSON.stringify({
        type: EVENT_STATUS.FAIL
      , timer: id
      , node: this[kNode]
      , message: error.message
      , stack: error.stack
      , error: error.code || error.name
      }), cb)
    })
  }

  /**
   * Clears the respective timer from storage and publishes a cancelled event via nats
   * @method module:skyring/lib/timer#cancelled
   * @param {String} id the is of the time to acknowledge as delivered successfully
   * @param {Nodeback} [callback] Callback to execute when the acknowledge is complete
   * @example timers.cancel('2e2f6dad-9678-4caf-bc41-8e62ca07d551')
   **/
  cancel(id, cb = noop) {
    this[kRemove](id, (err) => {
      if (err) return cb(err)
      cb()
      this.nats.publish('skyring:events', JSON.stringify({
        type: EVENT_STATUS.CANCELLED
      , timer: id
      , node: this[kNode]
      }))
    })
  }

  /**
   * Clears a specific timer from storage
   * @deprecated v5.0.0
   * @method module:skyring/lib/timer#delete
   * @param {String} id The id of the timer to cancel
   * @param {Nodeback} callback Node style callback to execute
   **/
  remove(id, cb = noop) {
    if (!this.warned){
      process.emitWarning(
        'timers#remove has been replaced with timers#cancel'
      + ' and will be removed in future versions'
      , 'DeprecationWarning'
      , 'EDEPRECATED'
      )

      this.warned = true
    }
    return this[kRemove](id, cb)
  }

  [kRemove](id, cb = noop) {
    this[storage].del(id, (err) => {
      if (err) return console.error('unable to purge %s', id, err);
      store('%s purged from storage', id, this.options.storage);
    });
    const t = this.get(id);
    if( !t ) {
      const err = new Error('Not Found');
      err.code = 'ENOENT';
      return setImmediate(cb, err);
    }
    clearTimeout(t.timer);
    this.delete(id);
    setImmediate(cb)
    debug('timer cleared', id);
  }

  rebalance(opts, node, cb = noop) {
    const size = this.size
        , batch = this[storage].batch()
        ;

    if( !size ) return;
    this.nats.publish('skyring:node', JSON.stringify({
      node: this[kNode]
    , type: EVENT_STATUS.REBALANCE
    }), noop)
    const records = this.values();
    const run = ( obj ) => {
      if ( node.owns( obj.id ) ) return;
      clearTimeout( obj.timer );
      this.delete( obj.id );
      batch.del(obj.id);
      const data = Object.assign({}, obj.payload, {
        id: obj.id
      , created: obj.created
      });
      rebalance( 'no longer the owner of %s', obj.id );
      this.nats.publish('skyring:events', JSON.stringify({
        node: this[kNode]
      , type: EVENT_STATUS.EVICT
      , timer: obj.id
      }), noop)
      cb( data );
    };

    for( var record of records ) {
      run( record );
    }
    batch.write(() => {
      store('rebalance batch delete complete');
    });
  }

  recover(cb = noop) {
    this.nats.publish('skyring:node', JSON.stringify({
      node: this[kNode]
    , type: EVENT_STATUS.RECOVERY
    }), noop)
    const fn = (data) => {
      store('recover', data.key);
      const out = Object.assign({}, data.value.payload, {
        id: data.value.id
      , created: data.value.created
      });
      this.create(data.key, out, debug);
    };

    const stream = this[storage].createReadStream();

    stream
    .on('data', fn)
    .once('close', function () {
      debug('recover stream close');
      stream.removeListener('data', fn);
      cb && cb();
    });
  }
  /**
   * Updates a timer inplace
   * @method module:skyring/lib/timer#update
   * @param {String} id A unique Id of the time
   * @param {Object} body Configuration options for the timer instance
   * @param {Number} body.timeout Duration in milisecods to delay execution of the timer
   * @param {String} body.data The data to be assicated with the timer, when it is executed
   * @param {Object} callback Options for the outbound transport for the timer when it executes
   * @param {String} callback.transport The transport type ( http, etc )
   * @param {String} transport.method The method the transport should use when executing the timer
   * @param {String} transport.uri The target uri for the transport when the timer executes
   * @param {Nodeback} callback
   * @example timers.update('0dc5a555-d0f6-49a0-b336-5befb0437288', {
  timeout: 4000
, data: "this is a payload"
, callback: {
    transport: 'http'
  , method: 'put'
  , uri: 'http://api.domain.com/callback'
  }
})
   **/
  update(id, body, cb) {
    this[kRemove](id, ( err ) => {
      if ( err ) return cb( err );
      debug( 'updating timer', id );
      this.create( id, body, cb );
    });
  }

  close(cb){
    this[storage].close(cb);
  }

  disconnect(cb = noop) {
    this[storage].close(noop)
    this.transports[shutdown](() => {
      this.nats.publish('skyring:node', JSON.stringify({
        node: this[kNode]
      , type: EVENT_STATUS.SHUTDOWN
      }), noop)
      setImmediate(this.nats.quit, cb)
    });
  }

  /**
   * Triggers timers to be rebalanced with in the ring before sutdown, and cancels all locally pending timers
   * @method module:skyring/lib/timer#shutdown
   * @param {Nodeback} callback Node style callback to execute when the function is complete
   **/
  shutdown(cb) {
    const size = this.size;
    const client = this.nats;

    if( !size ) {
      this[storage].close();
      return this.transports[shutdown](() => {
        this.nats.publish('skyring:node', JSON.stringify({
          node: this[kNode]
        , type: EVENT_STATUS.SHUTDOWN
        }), noop)
        this.nats.quit(cb);
      });
    }

    let sent = 0;
    let acks = 0;

    const batch = this[storage].batch();

    client.unsubscribe( this._sid );
    this._sid = null;

    const run = ( obj ) => {
      clearTimeout( obj.timer );
      batch.del(obj.id);
      const data = Object.assign({}, obj.payload, {
        id: obj.id
      , created: obj.created
      , count: ++sent
      });

      this.nats.publish('skyring', JSON.stringify( data ), () => {
        if( ++acks === size ) {
          return batch.write(() => {
            store('batch delete finished');
            this.disconnect(cb)
          });
        }
        rebalance( '%s of %s processed', data.count, acks, data.id);
      });
    };

    this.nats.publish('skyring:node', JSON.stringify({
      node: this[kNode]
    , type: EVENT_STATUS.PURGE
    }), noop)
    for( var record of this.values() ) {
      run( record );
    }
    this.clear();
  }

  /**
   * Starts an internal nats queue
   * @method module:skyring/lib/timer#watch
   * @param {String} key The key name in redis to use as a timer queue
   * @param {Nodeback} callback Node style callback to execute when the function has finished execution
   **/
  watch( key, cb ){
    if( this._bail ) return;
    const opts = { queue: key };
    this._sid = this.nats.subscribe('skyring', opts, ( data ) => {
      if( this._bail ) return;
      const value = json.parse( data );
      cb( value.error, value.value );
    });
    return this._sid;
  }
}

module.exports = Timer;
