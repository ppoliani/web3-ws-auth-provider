const _ = require('underscore');
const errors = require('web3-core-helpers').errors;
const Ws = require('@web3-js/websocket').w3cwebsocket;

const isNode = Object.prototype.toString.call(typeof process !== 'undefined' ? process : 0) === '[object process]';

let _btoa = null;
let parseURL = null;

if (isNode) {
  _btoa = str => {
    return Buffer.from(str).toString('base64');
  };

  const url = require('url');
  
  if (url.URL) {
      // Use the new Node 6+ API for parsing URLs that supports username/password
      const newURL = url.URL;
      parseURL = url => new newURL(url);
  }
  else {
      // Web3 supports Node.js 5, so fall back to the legacy URL API if necessary
      parseURL = require('url').parse;
  }
} 
else {
  _btoa = btoa;
  parseURL = url => new URL(url);
}


class WebsocketProvider {
  constructor(url, options={}) {
    if (!Ws) {
      throw new Error('websocket is not available');
    }

    this.responseCallbacks = {};
    this.notificationCallbacks = [];
    this._customTimeout = options.timeout;

    // The w3cwebsocket implementation does not support Basic Auth
    // username/password in the URL. So generate the basic auth header, and
    // pass through with any additional headers supplied in constructor
    const parsedURL = parseURL(url);
    const headers = options.headers || {};
    const protocol = options.protocol || undefined;

    if (parsedURL.username && parsedURL.password) {
      headers.authorization = 'Basic ' + _btoa(parsedURL.username + ':' + parsedURL.password);
    }

    // Allow a custom client configuration
    const clientConfig = options.clientConfig;

    // Allow a custom request options
    // https://github.com/theturtle32/WebSocket-Node/blob/master/docs/WebSocketClient.md#connectrequesturl-requestedprotocols-origin-headers-requestoptions
    const requestOptions = options.requestOptions;

    // When all node core implementations that do not have the
    // WHATWG compatible URL parser go out of service this line can be removed.
    if (parsedURL.auth) {
      headers.authorization = 'Basic ' + _btoa(parsedURL.auth);
    }

    this.connection = new Ws(url, protocol, undefined, headers, requestOptions, clientConfig);
    this.addDefaultEvents();
    this.connection.onmessage = this.onmessage;

    // make property `connected` which will return the current connection status
    Object.defineProperty(this, 'connected', {
      get: () =>  this.connection && this.connection.readyState === this.connection.OPEN,
      enumerable: true,
    });

    this.getAccessToken = options.getAccessToken;
    this.syncInterval = options.syncInterval || 60000 // 1 min

    return new Promise(async (resolve, reject) => {
      try {
        await this._syncAuth();
        resolve(this);
      }
      catch(error) {
        reject(error)
      }
    });
  }

  async _refreshToken() {
    try {
      const token = await this.getAccessToken();
      this.headers['Authorization'] = `Bearer ${token}`;
      
      this._tick();
    }
    catch(error) {
      throw new Error('Cannot get a new access token');
    }
  }

  async _syncAuth() {
    if(this.getAccessToken !== null) {
      await this._refreshToken();
      this._tick()
    }
  }

  _tick() {
    setTimeout(() => this.syncAuth(), this.syncInterval)
  }

  onmessage(e) {
    const data = (typeof e.data === 'string') ? e.data : '';

    this._parseResponse(data).forEach(result => {
      let id = null;

      // get the id which matches the returned id
      if(_.isArray(result)) {
        result.forEach(load => {
          if(this.responseCallbacks[load.id]) {
            id = load.id;
          }
        });
      } 
      else {
        id = result.id;
      }

      // notification
      if(!id && result && result.method && result.method.indexOf('_subscription') !== -1) {
        this.notificationCallbacks.forEach(callback => {
            if(_.isFunction(callback)) {
              callback(result);
            }
        });

        // fire the callback
      } 
      else if(this.responseCallbacks[id]) {
        this.responseCallbacks[id](null, result);
        delete this.responseCallbacks[id];
      }
    });
  }
  
  addDefaultEvents() {
    this.connection.onerror = this._timeout();

    this.connection.onclose = () => {
      this._timeout();

      // reset all requests and callbacks
      this.reset();
    };

  }

  _parseResponse(data) {
    const returnValues = [];

    // DE-CHUNKER
    const dechunkedData = data
      .replace(/\}[\n\r]?\{/g,'}|--|{') // }{
      .replace(/\}\][\n\r]?\[\{/g,'}]|--|[{') // }][{
      .replace(/\}[\n\r]?\[\{/g,'}|--|[{') // }[{
      .replace(/\}\][\n\r]?\{/g,'}]|--|{') // }]{
      .split('|--|');

    dechunkedData.forEach(data => {
      // prepend the last chunk
      if(this.lastChunk) {
        data = this.lastChunk + data;
      }

      let result = null;

      try {
        result = JSON.parse(data);
      } 
      catch(e) {
        this.lastChunk = data;

        // start timeout to cancel all requests
        clearTimeout(this.lastChunkTimeout);
        this.lastChunkTimeout = setTimeout(() => {
          this._timeout();
          throw errors.InvalidResponse(data);
        }, 1000 * 15);

        return;
      }

      // cancel timeout and set chunk to null
      clearTimeout(this.lastChunkTimeout);
      this.lastChunk = null;

      if(result) {
        returnValues.push(result);
      }
    });

    return returnValues;
  }

  _addResponseCallback(payload, callback) {
    const id = payload.id || payload[0].id;
    const method = payload.method || payload[0].method;

    this.responseCallbacks[id] = callback;
    this.responseCallbacks[id].method = method;

    // schedule triggering the error response if a custom timeout is set
    if (this._customTimeout) {
      setTimeout(() => {
        if (this.responseCallbacks[id]) {
          this.responseCallbacks[id](errors.ConnectionTimeout(this._customTimeout));
          delete this.responseCallbacks[id];
        }
      }, this._customTimeout);
    }
  }

  _timeout() {
    for(let key in this.responseCallbacks) {
      if(this.responseCallbacks.hasOwnProperty(key)){
        this.responseCallbacks[key](errors.InvalidConnection('on WS'));
        delete this.responseCallbacks[key];
      }
    }
  }

  send(payload, callback) {
    if (this.connection.readyState === this.connection.CONNECTING) {
      setTimeout(() =>  {
          this.send(payload, callback);
      }, 10);
      
      return;
    }

    // try reconnect, when connection is gone
    // if(!this.connection.writable)
    //     this.connection.connect({url: this.url});
    if (this.connection.readyState !== this.connection.OPEN) {
      console.error('connection not open on send()');
      if (typeof this.connection.onerror === 'function') {
        this.connection.onerror(new Error('connection not open'));
      } 
      else {
        console.error('no error callback');
      }
      
      callback(new Error('connection not open'));

      return;
    }

    this.connection.send(JSON.stringify(payload));
    this._addResponseCallback(payload, callback);
  }

  on(type, callback) {
    if(typeof callback !== 'function') {
      throw new Error('The second parameter callback must be a function.');
    }

    switch(type){
      case 'data':
        this.notificationCallbacks.push(callback);
        break;
      case 'connect':
        this.connection.onopen = callback;
        break;
      case 'end':
        this.connection.onclose = callback;
        break;
      case 'error':
        this.connection.onerror = callback;
        break;
    }
  }

  removeListener(type, callback) {
    switch(type){
      case 'data':
        this.notificationCallbacks.forEach((cb, index) => {
          if(cb === callback)
            this.notificationCallbacks.splice(index, 1);
        });
        break;

        // TODO remvoving connect missing

        // default:
        //     this.connection.removeListener(type, callback);
        //     break;
    }
  }

  removeAllListeners(type) {
    switch(type){
      case 'data':
        this.notificationCallbacks = [];
        break;
      case 'connect':
        this.connection.onopen = null;
        break;
      case 'end':
        this.connection.onclose = null;
        break;
      case 'error':
        this.connection.onerror = null;
        break;
      default:
          // this.connection.removeAllListeners(type);
        break;
    }    
  }

  reset() {
    this._timeout();
    this.notificationCallbacks = [];

    // this.connection.removeAllListeners('error');
    // this.connection.removeAllListeners('end');
    // this.connection.removeAllListeners('timeout');

    this.addDefaultEvents();
  }

  disconnect() {
    if (this.connection) {
      this.connection.close();
    }
  }

  supportsSubscriptions() {
    return true;
  }
}

module.exports = WebsocketProvider;
