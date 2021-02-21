const Ledger = require(".");
const rimraf = require('rimraf');
const expect = require("chai").expect;
const fs = require('fs');

rimraf.sync('./test_db');
rimraf.sync('./test_db2');
rimraf.sync('./test_db3');

//scaffolding
var db1 = new Ledger({
  base_state: { counter: 0 },
  store_path: "./test_db",
  private_key: "0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f"
});

var db2 = new Ledger({
  base_state: { counter: 0 },
  store_path: "./test_db2",
  private_key: "2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c"
});

var db3 = new Ledger({
  base_state: { counter: 0 },
  store_path: "./test_db3",
  private_key: "3e3e3e3e3e3e3e3e3e3e3e3e3e3e3e3e3e3e3e3e3e3e3e3e3e3e3e3e3e3e3e3e"
});

db1.setReducer('increment', function (state, issuer, payload) {
  state.counter++;
});

db2.setReducer('increment', function (state, issuer, payload) {
  state.counter++;
});

db3.setReducer('increment', function (state, issuer, payload) {
  state.counter++;
});

db1.onMilestone(async function () {
  console.log('db1 got ms');
  var state = await db1.getState();
  console.log(state);
  if (state.counter == 1) {
    console.log('first');
  } else if (state.counter == 2) {
    console.log('second');
    db1.shutDown();
  } else {
    console.log('wrong ms!');
  }
});
db2.onMilestone(async function () {
  console.log('db2 got ms');
  var ms = db2.getLastMilestone();
  var state = await db2.getState();
  console.log(state);
  if (state.counter == 1) {
    console.log('first');
  } else if (state.counter == 2) {
    console.log('second');
    db2.shutDown();
  } else {
    console.log('wrong ms!');
  }
});
db3.onMilestone(async function () {
  console.log('db3 got ms');
  var ms = db3.getLastMilestone();
  var state = await db3.getState();
  console.log(state);
  if (state.counter == 1) {
    console.log('first');
  } else if (state.counter == 2) {
    console.log('second');
    db3.shutDown();
  } else {
    console.log('wrong ms!');
  }
});

var onEvent;
var onMS;

async function waitFor(time) {
  return new Promise(function (resolve, reject) {
    setTimeout(function () {
      resolve(true);
    }, time);
  });
}

describe('scaffolding', function () {
  it('inits', async function () {
    await db1.init();
    await db2.init();
    await db3.init();
  });
})

describe('startServer(port, callback)', function () {
  it('should open a host and accept connections', function (done) {
    db1.startServer('1337', function () {
      try {
        db2.connectTo('localhost', '1337', function () {
          done();
        });
      } catch (e) {
        done(e);
      }
    });
  });
});

describe('createEvent', function () {
  it('should create and save valid event', async function () {
    this.timeout(15000);
    id1 = await db1.createEvent('increment', 'up');
    console.log(id1);
    var state = await db1.getStateAt(id1);
    expect(state.counter).to.equal(1);
  });
  it('should send those events out to neighbors', function (done) {
    this.timeout(10000);
    (async function () {
      onEvent = async function () {
        var state = await db1.getStateAt(id2);
        try {
          expect(state.counter).to.equal(2);
          done();
        } catch (e) {
          done(e);
        }
        onEvent = undefined;
      }
      db1.onEvent(onEvent);
      id2 = await db2.createEvent('increment', 'up');
      console.log(id2);
    })();
  });
});

describe('getStateAt(milestone  [,filter])', function () {
  it('should return the state using the passed ID as a milestone', async function () {
    this.timeout(2000);
    waitFor(500);
    var state = await db2.getStateAt(id2);
    var state2 = await db1.getStateAt(id2);
    expect(state.counter).to.equal(2);
    expect(state2.counter).to.equal(2);
  });
  it('should support passing a filter', async function () {
    this.timeout(2000);
    var state = await db1.getState(id2, function (type, issuer, payload, digest) {
      return digest != id1;
    });
    expect(state.counter).to.equal(0);
  });
});
console.log('waiting for milsetones to get picked up: ');