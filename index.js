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
  self.heartBeat();

  await this.store.init(this.store_path);

  this.stream.subscribe('hello', async function (message, context) {
    self.onHello(message, context);
  });

  this.stream.subscribe('propose', async function (message, context) {
    self.onPropose(message, context);
  });

  this.stream.subscribe('accept', async function (message, context) {
    self.onAccept(message, context);
  });

  this.stream.subscribe('apply', async function (message, context) {
    self.onApply(message, context);
  });

  //Events are the general actions a node broadcases
  this.stream.subscribe('event', async function (event, context) {
    var confirmed = await self.processEvent(event);
    if (confirmed) {
      for (let i in self.subscriptions.event) {
        self.subscriptions.event[i]();
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
    self.sayHello();
    callback();
  });
};

Ledger.prototype.shutDown = function () {
  this.stream.shutDown();
  clearTimeout(this.heartbeat_timeout);
}


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

  if (have_left == false || have_right == false) {
    return false;
  }

  var ms = this.getLastMilestone();
  if (ms = decoded.dig) {
    return true;
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
      var check = next.lt;
      if (check == '0' || check == '00') {
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

Ledger.prototype.listKown = function () {
  return this.known;
}

Ledger.prototype.sayHello = function () {
  var timestamp = Date.now();
  var message = Events.simpleSign(timestamp, this.private);
  this.stream.shout('hello', message);
}

Ledger.prototype.onHello = function (message, context) {
  var valid = Events.simpleValidate(message);
  if (!valid) { return false; }
  var decoded = JSON.parse(message);
  var timestamp = decoded.cnt;
  var public = decoded.iss;
  if (typeof this.known[public] == 'undefined' || this.known[public]['tt'] < timestamp) {
    var my_time = Date.now();
    this.known[public] = {
      tt: timestamp,
      mt: my_time,
      state: 'idle'
    };
    context.relay('hello', message);
  }
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

Ledger.prototype.propose = function (milestone) {
  this.state = 'proposing';
  this.milestone = milestone;
  var proposal = JSON.stringify({
    "ts": Date.now(),
    "ms": milestone
  });
  var message = Events.simpleSign(proposal, this.private);
  this.stream.shout('propose', message);
}

Ledger.prototype.accept = function (milestone) {
  this.state = 'accepting';
  this.milestone = milestone;
  var acceptance = JSON.stringify({
    "ts": Date.now(),
    "ms": milestone
  });
  var message = Events.simpleSign(acceptance, this.private);
  this.stream.shout('accept', message);
}

Ledger.prototype.apply = async function (milestone) {
  var confirmed = await this.processEvent(milestone);
  if (confirmed) {
    this.state = 'idle';
    this.milestone = milestone;
    decoded = JSON.parse(milestone);
    this.addMilestone(decoded.dig);
    //if idle, the milstone set is the last milestone
    var application = JSON.stringify({
      "ts": Date.now(),
      "ms": milestone
    });
    var message = Events.simpleSign(application, this.private);
    this.stream.shout('apply', message);
  }
};

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
  if (typeof this.known[public] == 'undefined' || this.known[public]['tt'] < timestamp) {
    var my_time = Date.now();
    this.known[public] = {
      tt: timestamp,
      mt: my_time,
      state: 'proposing',
      ms: milestone
    };

    context.relay('propose', message);
  }
}

Ledger.prototype.onAccept = async function (message, context) {
  var valid_sig = Events.simpleValidate(message);
  if (!valid_sig) { return false; }

  var decoded = JSON.parse(message);
  var acceptance = JSON.parse(decoded.cnt);

  var timestamp = acceptance.ts;
  var public = decoded.iss;
  var milestone = acceptance.ms;
  var mt = Date.now();

  var valid_ms = await this.validateMilestone(milestone);
  if (!valid_ms) { return false; }
  if (typeof this.known[public] == 'undefined' || this.known[public]['tt'] < timestamp) {
    var my_time = Date.now();
    this.known[public] = {
      tt: timestamp,
      mt: my_time,
      state: 'accepting',
      ms: milestone
    };

    context.relay('accept', message);
  }
}

Ledger.prototype.onApply = async function (message, context) {
  var valid_sig = Events.simpleValidate(message);
  if (!valid_sig) { return false; }

  var decoded = JSON.parse(message);
  var application = JSON.parse(decoded.cnt);

  var timestamp = application.ts;
  var public = decoded.iss;
  var milestone = application.ms;
  var mt = Date.now();

  var valid_ms = await this.validateMilestone(milestone);
  if (!valid_ms) { return false; }

  if (typeof this.known[public] == 'undefined' || this.known[public]['tt'] < timestamp) {
    var my_time = Date.now();
    this.known[public] = {
      tt: timestamp,
      mt: my_time,
      state: 'idle',
      ms: milestone
    };

    context.relay('apply', message);
  }
}


/*
Heartbeat
*/
Ledger.prototype.heartBeat = async function () {
  var key = ec.keyFromSecret(this.private);
  var public = key.getPublic('hex');
  if (this.stream.peers.length > 0) {
    var my_time = Date.now();
    var keys = Object.keys(this.known);
    for (var public in this.known) {
      if (my_time - this.known[public].mt > 15000) {
        this.known[public].state = 'offline';
      }
    }

    var application = await this.checkForApplication();
    if (application != false && application.percent > (2 / 3)) {
      var tip = await this.store.getRandomTip('0');
      if (tip == this.getLastMilestone()) {
        //if there's nothing new to do just keep telling them about the last one
        this.apply(this.milestone);
      } else {
        var milestone = this.createMilestone(tip);
        this.propose(milestone);
      }
    } else {
      var acceptance = await this.checkForAcceptance();
      if (acceptance != false && acceptance.percent >= (2 / 3)) {
        this.apply(acceptance.winning);
      } else {
        var proposal = await this.checkForProposals();
        if (proposal != false && proposal.percent >= (2 / 3)) {
          this.accept(proposal.winning);
        } else if (proposal != false) {
          this.propose(proposal.winning);
        } else if (this.state == 'accepting') {
          this.accept(this.milestone);
        } else if (this.state == 'proposing') {
          this.propose(this.milestone);
        } else {
          var tip = await this.store.getRandomTip('0');
          if (tip == this.getLastMilestone()) {
            this.sayHello();
          } else {
            var milestone = this.createMilestone(tip);
            this.propose(milestone);
          }
        }
      }
    }
  }

  var self = this;
  this.heartbeat_timeout = setTimeout(function () {
    self.heartBeat();
  }, Math.floor(((Math.random() * 3) + 0) * 1000));
}

Ledger.prototype.checkForApplication = async function () {
  var others = Object.keys(this.known);
  var considering = {};
  for (var i in others) {
    var other = this.known[others[i]];
    if (other.state == 'idle') {
      if (typeof other.ms == 'undefined') {
        continue;
      }
      var ms = other.ms;
      if (await this.validateMilestone(ms)) {
        if (typeof considering[ms] == 'undefined') {
          considering[ms] = 1;
        } else {
          considering[ms]++;
        }
      }
    }
  }
  //don't include yourself?
  var highest = 0;
  var winner = undefined;
  var keys = Object.keys(considering);
  for (var i in keys) {
    if (considering[keys[i]] > highest) {
      winner = keys[i];
      highest = considering[keys[i]];
    }
  }
  if (highest > 0) {
    return {
      winning: winner,
      percent: highest / (others.length + 1)
    };
  } else {
    return false;
  }
}

Ledger.prototype.checkForAcceptance = async function () {
  var others = Object.keys(this.known);
  var considering = {};
  for (var i in others) {
    var other = this.known[others[i]];
    if (other.state == 'accepting' || other.state == 'idle') {
      if (typeof other.ms == 'undefined') {
        continue;
      }
      var ms = other.ms;
      if (await this.validateMilestone(ms)) {
        if (typeof considering[ms] == 'undefined') {
          considering[ms] = 1;
        } else {
          considering[ms]++;
        }
      }
    }
  }
  //include yourself
  if (this.state == 'accepting' || (this.state == 'idle' && typeof this.milestone != 'undefined')) {
    var ms = this.milestone;
    if (typeof considering[ms] == 'undefined') {
      considering[ms] = 1;
    } else {
      considering[ms]++;
    }
  }
  var highest = 0;
  var winner = undefined;
  var keys = Object.keys(considering);
  for (var i in keys) {
    if (considering[keys[i]] > highest) {
      winner = keys[i];
      highest = considering[keys[i]];
    }
  }
  if (highest > 0) {
    return {
      winning: winner,
      percent: highest / (others.length + 1)
    };
  } else {
    return false;
  }
}

Ledger.prototype.checkForProposals = async function () {
  var others = Object.keys(this.known);
  var considering = {};
  for (var i in others) {
    var other = this.known[others[i]];
    if (other.state == 'proposing' || other.state == 'accepting') {
      var ms = other.ms;
      if (await this.validateMilestone(ms)) {
        if (typeof considering[ms] == 'undefined') {
          considering[ms] = 1;
        } else {
          considering[ms]++;
        }
      }
    }
  }
  //include yourself
  if (this.state == 'proposing' || this.state == 'accepting') {
    var ms = this.milestone;
    if (typeof considering[ms] == 'undefined') {
      considering[ms] = 1;
    } else {
      considering[ms]++;
    }
  }
  var highest = 0;
  var winner = undefined;
  var keys = Object.keys(considering);
  for (var i in keys) {
    if (considering[keys[i]] > highest) {
      winner = keys[i];
      highest = considering[keys[i]];
    }
  }
  if (highest > 0) {
    return {
      winning: winner,
      percent: highest / (others.length + 1)
    };
  } else {
    return false;
  }
}

module.exports = Ledger;