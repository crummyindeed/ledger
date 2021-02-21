const crypto = require('crypto');
const EdDSA = require('elliptic').eddsa;
const ec = new EdDSA('ed25519');

const Events = require('crummyevents');
const Stream = require('@the3rdc/netshout');
const Store = require('crummygraph');
const fs = require('fs');
const path = require('path');

var Ledger = function ({
  base_state,
  store_path,
  private_key,
  isMilestone,
  debug
}) {
  this.timeout;
  this.following;
  this.base_state = base_state;
  this.reducers = {};
  this.private = private_key;
  this.store_path = store_path;
  this.ms_file = path.join(store_path, 'milestones.js');
  try {
    var ms_content = fs.readFileSync(this.ms_file);
    this.milestones = JSON.parse(ms_content);
  } catch (e) {
    this.milestones = [];
  }
  this.store = new Store();
  this.stream = new Stream({ debug: debug });
  this.isMilestone = isMilestone;
  this.subscriptions = {
    ms: [],
    event: []
  };
}

Ledger.prototype.init = async function () {
  var self = this;

  this.known = {};
  this.state = 'idle';
  this.milestone;
  this.startTimeout();

  await this.store.init(this.store_path);
  //Events are the general actions a node broadcases
  this.stream.subscribe('event', async function (event, context) {
    var confirmed = await self.processEvent(event);
    if (confirmed) {
      for (let i in self.subscriptions.event) {
        self.subscriptions.event[i](JSON.parse(event));
      }
      context.relay('event', event);
    } else {
      decoded = JSON.parse(event);
      self.challenge(decoded.dig);
    }
  });

  //a challenege sends the ID of an unkown event, and a milestone to start at, requestsing the chain of events in between
  this.stream.subscribe('challenge', async function ({ id, from_ms }, context) {
    var exists = await self.store.get(id);
    if (exists == false) {
      return false;
    }

    var chain = await self.buildProofChain({ id, from_ms });
    context.reply('proof', {
      for: id,
      prf: chain
    });

  });

  //a proof is the response to a challenge - gives me the itemrs in between
  this.stream.subscribe('proof', async function (data) {
    for (let i in data.prf) {
      var valid = await self.processEvent(data.prf[i]);
    }
  });

}


/*
Servers and Connections
*/

Ledger.prototype.startServer = function (port, callback) {
  var self = this;
  this.stream.startHosting(port, callback, async function () {
    /*
    this will run when a new node connects to me
    auto-shouting my last milestone in that case to allow newcomers to catch up
    */
    //var latest = self.getLastMilestone();
    var latest = false;
    if (latest) {
      var ms_event = JSON.parse(await self.store.get(latest));
      self.stream.shout('event', JSON.stringify(ms_event.event));
    }
  });
}

Ledger.prototype.connectTo = function (address, port, callback) {
  var self = this;
  this.stream.connectTo(address, port, function () {
    callback();
  });
};

Ledger.prototype.shutDown = function () {
  this.stream.shutDown();
  clearTimeout(this.timeout);
}

Ledger.prototype.challenge = function (id) {
  var last = this.getLastMilestone();
  if (last) {
    this.stream.shout('challenge', { id, from_ms: last });
  } else {
    this.stream.shout('challenge', { id });
  }
};

Ledger.prototype.buildProofChain = async function ({ id, from_ms }) {
  var chain = [];
  await this.store.dflfs({
    from_id: id,
    to_id: from_ms,
    reducer: (event) => {
      chain.push(JSON.stringify(event));
    }
  });
  return chain;
};

/*
Event Creation and Proceessing
*/

Ledger.prototype.createEvent = async function (type, payload) {
  if (this.private == false) {
    throw "cannot create events without a private key";
  }
  //need a way to choose what MS to get tips from
  var tips = await this.store.getTips('0');

  if (tips === false || tips.length == 0) {
    var left = '0';
    var right = '00';
  } else if (tips.length == 1) {
    var left = '0';
    var right = tips[0];
  } else {
    var index = Math.floor(Math.random() * tips.length);
    var left = tips[index];
    tips.splice(index, 1);
    var right = tips[Math.floor(Math.random() * tips.length)];
  }

  var event = Events.create({
    type: type,
    payload: payload,
    left: left,
    right: right
  }, this.private);

  var decoded = JSON.parse(event);

  var confirmed = await this.processEvent(event);
  if (confirmed) {
    this.stream.shout('event', event);
  }

  return decoded.dig;
}

Ledger.prototype.processEvent = async function (event) {
  //first make sure it's valid
  var valid = Events.validate(event);
  if (!valid) { return false; }

  //now check it's dependencies
  var decoded = JSON.parse(event);

  var have_left = await this.store.get(decoded.lt);
  var have_right = await this.store.get(decoded.rt);

  if (have_left == false || have_right == false) {
    return false;
  }

  //okay, if it's valid and we confirmed it's deps we'll confirm it too!
  var added = await this.store.put(decoded.dig, decoded, decoded.lt, decoded.rt);

  if (added && this.isMilestone !== undefined) {
    if (this.isMilestone(decoded)) {
      this.addMilestone(decoded.dig);
    }
  }
  return added;
};

Ledger.prototype.validateMilestone = async function (event) {
  var valid = Events.validate(event);
  if (!valid) { return false; }

  //now check it's dependencies
  var decoded = JSON.parse(event);
  var have_left = await this.store.get(decoded.lt);
  var have_right = await this.store.get(decoded.rt);

  if(have_left == false){
    this.challenge(decoded.lt);
    return false;
  }

  if(have_right == false){
    this.challenge(decoded.rt);
    return false;
  }

  var ms = this.getLastMilestone();
  if (ms == decoded.dig) {
    return false;
    //I'm not gonna relay it if I already have it.
  }

  return true;
  //for now accepting it as long as I have deps.
  var check = decoded.lt;
  var searching = true;
  var found = false;

  //currently only checking left
  //merging split chains still an issue.
  while (searching) {
    console.log('searching');
    searching = false;
    if (ms == check) {
      found = true;
    } else {
      searching = true;
      var next = await this.store.get(check);
      if(next == false){
        this.challenge(check);
        return false;
      }
      var check = next.lt;
      if (check == '0' || check == '00') {
        console.log('never found');
        found = false;
        searching = false;
      }
    }
  }

  return found;
}


/*
State and Queries
*/

Ledger.prototype.getStateAt = async function (milestone, filter) {
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

Ledger.prototype.getState = async function (filter) {
  if (this.milestones.length == 0) {
    return this.base_state;
  }
  var most_recent = this.milestones[0];
  console.log(most_recent);
  return await this.getStateAt(most_recent, filter);
};

Ledger.prototype.setReducer = function (type, callback) {
  this.reducers[type] = callback;
};


/*

Utilities & Consensus

*/

Ledger.prototype.onMilestone = function (callback) {
  this.subscriptions.ms.push(callback);
}

Ledger.prototype.onEvent = function (callback) {
  this.subscriptions.event.push(callback);
}

Ledger.prototype.addMilestone = function (milestone) {
  this.milestones.unshift(milestone);
  fs.writeFileSync(this.ms_file, JSON.stringify(this.milestones));
  for (let i in this.subscriptions.ms) {
    this.subscriptions.ms[i]();
  }
}

Ledger.prototype.getLastMilestone = function () {
  if (this.milestones.length == 0) {
    return false;
  } else {
    return this.milestones[0];
  }
}

Ledger.prototype.createMilestone = function (right) {
  if (this.private == false) {
    return;
  }
  var ms = this.getLastMilestone();
  if (ms === false) {
    ms = '0';
  }

  var event = Events.create({
    type: 'ms',
    payload: {},
    left: ms,
    right: right
  }, this.private);

  return event;
}

Ledger.prototype.propose = async function (milestone) {
  this.state = 'proposing';
  this.milestone = milestone;
  var proposal = JSON.stringify({
    "ts": Date.now(),
    "ms": milestone
  });
  var message = Events.simpleSign(proposal, this.private);

  var valid_ms = await this.validateMilestone(milestone);
  this.addMilestone(milestone);

  this.stream.shout('propose', message);
}

Ledger.prototype.onPropose = async function (message, context) {
  var valid_sig = Events.simpleValidate(message);
  if (!valid_sig) { return false; }

  var decoded = JSON.parse(message);
  var proposal = JSON.parse(decoded.cnt);

  var timestamp = proposal.ts;
  var public = decoded.iss;
  var milestone = proposal.ms;
  var mt = Date.now();

  var valid_ms = await this.validateMilestone(milestone);
  if (!valid_ms) { return false; }

  this.addMilestone(decoded.dig);
  this.following = public;
  this.startTimeout();
  context.relay('propose', message);
}

/*
Timeout
*/
Ledger.prototype.startTimeout = function(time){
  if(typeof(time == undefined)){
    time = Math.floor(((Math.random() * 30000) + 30000));
  }
  if(typeof this.timeout != undefined){
    clearTimeout(this.timeout);
  }
  var self = this;
  this.timeout = setTimeout(async function(){
    var tip = await self.store.getRandomTip('0');
    if (tip == self.getLastMilestone()) {
      //if there's nothing new to do just chill
    } else {
      var milestone = self.createMilestone(tip);
      console.log('proposing', tip);
      self.propose(milestone);
    }
    self.startTimeout(3000);
  },time);
}

module.exports = Ledger;