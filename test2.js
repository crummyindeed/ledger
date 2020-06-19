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

var id1;
var id2;
var id3;

db1.onMilestone(async function () {
  console.log('db1 got ms');
  console.log(await db1.getState());
});
db2.onMilestone(async function () {
  console.log('db2 got ms');
  console.log(await db2.getState());
});
db3.onMilestone(async function () {
  console.log('db3 got ms');
  console.log(await db3.getState());
});

async function main() {
  await db1.init();
  await db2.init();
  await db3.init();
  db1.startServer('1337', function () {
    try {
      db2.connectTo('localhost', '1337', function () {
        db3.connectTo('localhost', '1337', async function () {
          console.log('making 1');
          db1.createEvent('increment', 'up');
          console.log('making 2');
          db3.createEvent('increment', 'up');
          console.log('making 3');
          db2.createEvent('increment', 'up');
        });
      });
    } catch (e) {
      console.log(e);
    }
  });
}
main();