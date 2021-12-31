const crypto = require('crypto');
const EdDSA = require('elliptic').eddsa;
const ec = new EdDSA('ed25519');

const Events = require('crummyevents');
const Stream = require('@the3rdc/netshout');
const Store = require('crummygraph');
const fs = require('fs');
const path = require('path');

var LedgerGraph = function({
  base_state,
  store_path,
  private_key,
  debug}){
  this.base_state = base_state;
  this.reducers = {};
  this.private_key = private_key;
  this.store_path = store_path;
  this.ms_file = path.join(store_path, 'milestones.js');
  try {
    var ms_content = fs.readFileSync(this.ms_file);
    this.milestones = JSON.parse(ms_content);
  } catch (e) {
    this.milestones = {};
  }
  this.store = new Store();
  this.stream = new Stream({debug: debug});
  this.subscriptions = {
    ms: [],
    event: []
  };
};

LedgerGraph.prototype.init = async function(){
  var self = this;

  await this.store.init(this.store_path);
  this.stream.subscribe('event', async function(event, context){
    var confirmed = await self.processEvent(event);
    if(confirmed){
      for(let i in self.subscriptions.event){
        self.subscriptions.event[i](JSON.parse(event));
      }
      context.relay('event', event);
    }else{
      decoded = JSON.parse(event);
      self.challenge(decoded.dig, decoded.pay._auth);
    }
  });
  
  this.stream.subscribe('challenge', async function({ id, from_ms }, context){
    var exists = await self.store.get(id);
    if(exists == false){
      return false;
    }

    var chain = await self.buildProofChain({ id, from_ms });
    context.reply('proof', {
      for: id,
      prf: chain
    });
  });

  this.stream.subscribe('proof', async function(data){
    for (let i in data.prf){
      //this needs moved in to crummyledger
      var confirmed = await self.processEvent(data.prf[i]);
      if(confirmed){
        self.stream.shout('event', data.prf[i]);
      }
    }
  });

  this.stream.subscribe('ping', async function(data, context){
    context.reply('pingback', {});
  });

  this.stream.subscribe('catchUp',async function(data, context){
    var latest = self.getLastMilestone(authority);
    if(latest){
      var ms_event = JSON.parse(await self.store.get(latest));
      self.context.reply('event', JSON.stringify(ms_event.event));
    }
  })
};

/*
Servers and Connections
*/

LedgerGraph.prototype.startServer = function (port, callBack){
  var self = this;
  this.stream.startHosting(port, callBack, async function(){
    /*
    this will run when a new node connects to me
    auto-shouting my last milestone in that case to allow newcomers to catch up
    */
    var latest = false;
    //Dunno which auth to send... so they will just have to wait for now.
    //var latest = self.getLastMilestone();
    if(latest){
      var ms_event = JSON.parse(await self.store.get(latest));
      self.stream.shout('event', JSON.stringify(ms_event.event));
    }
  });
}

LedgerGraph.prototype.connectTo = function(address, port, callBack){
  var self = this;
  this.stream.connectTo(address, port, function(){
    callBack();
  });
}

LedgerGraph.prototype.ping = function(){
  var self = this;
}

LedgerGraph.prototype.shutDown = function(){
  this.stream.shutDown();
}

LedgerGraph.prototype.challenge = function(id, authority){
  var last = this.getLastMilestone(authority);
  if(last){
    this.stream.shout('challenge', {id, from_ms: last});
  }else{
    this.stream.shout('challenge', {id});
  }
}

LedgerGraph.prototype.catchUp = function(authority){
  this.stream.shout('catchUp', {auth: authority});
}

LedgerGraph.prototype.buildProofChain = async function({id, from_ms}) {
  var chain = [];
  await this.store.dflfs({
    from_id: id,
    to_id: from_ms,
    reducer: (event) => {
      chain.push(JSON.stringify(event));
    }
  });
  return chain;
}

/*
Event Creation and Processing
*/

LedgerGraph.prototype.createEvent = async function (type, payload, authority){
  if(this.private_key == false){
    throw "cannot create events without a private key";
  }
  //need a way to choose what MS to get tips from
  var tips = await this.store.getTips('0');

  if(tips === false || tips.length == 0){
    var left = '0';
    var right = '00';
  }else if(tips.length == 1){
    var left = '0';
    var right = tips[0];
  }else{
    var index = Math.floor(Math.random() * tips.length);
    var left = tips[index];
    tips.splice(index,1);
    var right = tips[Math.floor(Math.random() * tips.length)];
  }

  payload._auth = authority;

  var event = Events.create({
    type: type,
    payload: payload,
    left: left,
    right: right
  }, this.private_key);

  var decoded = JSON.parse(event);

  var confirmed = await this.processEvent(event);
  if(confirmed){
    this.stream.shout('event', event);
  }

  return decoded.dig;
}

LedgerGraph.prototype.processEvent = async function(event){
  //first make sure it's valid
  var valid = Events.validate(event);
  if(!valid){ return false; }

  //now check it's dependencies
  var decoded = JSON.parse(event);

  var have_left = await this.store.get(decoded.lt);
  var have_right = await this.store.get(decoded.rt);

  if(have_left == false || have_right == false){
    return false;
  }

  //okay, if it's valid and we confirmed it's deps we'll confirm it too!
  var added = await this.store.put(decoded.dig, decoded, decoded.lt, decoded.rt);

  if(added){
    if(await this.isMilestone(decoded)){
      this.addMilestone(decoded.dig, decoded.iss);
    }
  }

  return added;
}

/*
State and Queries
*/

LedgerGraph.prototype.getStateAt = async function (milestone, filter) {
  var state = JSON.parse(JSON.stringify(this.base_state));
  var self = this;
  await this.store.dflfs({
    from_id: milestone, reducer: (event) => {
      var type = event.typ;
      var issuer = event.iss;
      var payload = event.pay;
      var digest = event.dig;
      if (typeof self.reducers[type] == 'function') {
        if (typeof filter == 'function') {
          if (filter(type, issuer, payload, digest)) {
            self.reducers[type](state, issuer, payload, digest);
          }
        } else {
          self.reducers[type](state, issuer, payload, digest);
        }
      }
    }
  });
  return state;
};

LedgerGraph.prototype.getState = async function (authority) {
  if (typeof this.milestones[authority] == 'undefined' || this.milestones[authority].length == 0) {
    return this.base_state;
  }
  var most_recent = this.milestones[authority][0];
  return await this.getStateAt(most_recent, function(type, issuer, payload, digest){
    return payload._auth == authority;
  });
};

LedgerGraph.prototype.getStateCustom = async function (authority, base_state, reducers) {
  if (typeof this.milestones[authority] == 'undefined' || this.milestones[authority].length == 0) {
    return base_state;
  }
  var most_recent = this.milestones[authority][0];
  return await this.getStateAtCustom(most_recent, function(type, issuer, payload, digest){
    return payload._auth == authority;
  }, base_state, reducers);
};

LedgerGraph.prototype.getStateAtCustom = async function (milestone, filter, base_state, reducers) {
  var state = JSON.parse(JSON.stringify(base_state));
  await this.store.dflfs({
    from_id: milestone, reducer: (event) => {
      var type = event.typ;
      var issuer = event.iss;
      var payload = event.pay;
      var digest = event.dig;
      if (typeof reducers[type] == 'function') {
        if (typeof filter == 'function') {
          if (filter(type, issuer, payload, digest)) {
            reducers[type](state, issuer, payload, digest);
          }
        } else {
          reducers[type](state, issuer, payload, digest);
        }
      }
    }
  });
  return state;
};

LedgerGraph.prototype.setReducer = function (type, callback) {
  this.reducers[type] = callback;
};

LedgerGraph.prototype.useFramework = function(framework){
  this.base_state = framework.base_state;
  this.call = {};
  for(var i in framework.events){
    var args = framework.events[i].args;
    this.call[framework.events]
  }
}

LedgerGraph.prototype.query = function({authority, callBack}){
  //TODO: Since ID and Filters
  //false == NONE (doesn't matter which!)
  if (typeof this.milestones[authority] == 'undefined' || this.milestones[authority].length == 0) {
    callBack(false);
  }
  var most_recent = this.milestones[authority][0];
  this.store.dflfs({
    from_id: most_recent, reducer: (event) => {
      callBack(event);
    }
  });
};

/*
Utilities & Consensus
*/

LedgerGraph.prototype.onMilestone = function (authority, callback) {
  if(typeof this.subscriptions.ms[authority] == 'undefined'){
    this.subscriptions.ms[authority] = [];
  }
  this.subscriptions.ms[authority].push(callback);
}

LedgerGraph.prototype.onEvent = function (callback) {
  this.subscriptions.event.push(callback);
}

LedgerGraph.prototype.addMilestone = function (milestone, authority) {
  if(typeof this.milestones[authority] == 'undefined'){
    this.milestones[authority] = [];
  }
  this.milestones[authority].unshift(milestone);
  fs.writeFileSync(this.ms_file, JSON.stringify(this.milestones));
  if(typeof this.subscriptions.ms[authority] != 'undefined'){
    for (let i in this.subscriptions.ms[authority]) {
      this.subscriptions.ms[authority][i]();
    }
  }
}

LedgerGraph.prototype.getLastMilestone = function (authority) {
  if (typeof this.milestones[authority] == 'undefined' || this.milestones[authority].length == 0) {
    return false;
  } else {
    return this.milestones[authority][0];
  }
}

LedgerGraph.prototype.isMilestone = async function (event){
  var type = event.typ;
  var issuer = event.iss;
  var payload = event.pay;

  if(type == '_ms' && payload._auth == issuer){
    var valid = await this.validateMilestone(JSON.stringify(event), issuer);
    return valid;;
  }else{
    return false;
  }
}

LedgerGraph.prototype.validateMilestone = async function (event, authority) {
  var valid = Events.validate(event);
  if (!valid) { return false; }

  //now check it's dependencies
  var decoded = JSON.parse(event);
  var have_left = await this.store.get(decoded.lt);
  var have_right = await this.store.get(decoded.rt);

  if(have_left == false){
    this.challenge(decoded.lt, authority);
    return false;
  }

  if(have_right == false){
    this.challenge(decoded.rt, authority);
    return false;
  }

  var ms = this.getLastMilestone(authority);
  if (ms == decoded.dig) {
    return false;
    //I'm not gonna relay it if I already have it.
  }

  var check = decoded.lt;
  var searching = true;
  var found = false;

  while (searching) {
    searching = false;
    if (ms == check) {
      found = true;
    } else {
      searching = true;
      var next = await this.store.get(check);
      if(next == false){
        this.challenge(check, authority);
        return false;
      }
      var check = next.lt;
      if (check == '0' || check == '00') {
        found = false;
        searching = false;
      }
    }
  }

  return found;
}

LedgerGraph.prototype.createMilestone = async function (authority, right) {
  if (this.private_key == false) {
    return;
  }
  var ms = this.getLastMilestone(authority);
  if (ms === false) {
    ms = '0';
  }

  var event = Events.create({
    type: '_ms',
    payload: {
      _auth: authority
    },
    left: ms,
    right: right
  }, this.private_key);

  var decoded = JSON.parse(event);

  var confirmed = await this.processEvent(event);
  if(confirmed){
    this.stream.shout('event', event);
  }

  return decoded.dig;
}

module.exports = LedgerGraph;