const LedgerGraph = require("./index.js");
const rimraf = require('rimraf');
const expect = require("chai").expect;
const fs = require('fs');

const Counter = require("./sample_ledger.js");

rimraf.sync('./test_db');
rimraf.sync('./test_db2');
rimraf.sync('./test_db3');

//scaffolding
var db1 = new LedgerGraph({
  base_state: { counter: 0 },
  store_path: "./test_db",
  private_key: "0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f"
});
var c1 = new Counter(db1);

var db2 = new LedgerGraph({
  base_state: { counter: 0 },
  store_path: "./test_db2",
  private_key: "2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c"
});
var c2 = new Counter(db2);

var db3 = new LedgerGraph({
  base_state: { counter: 0 },
  store_path: "./test_db3",
  private_key: "3e3e3e3e3e3e3e3e3e3e3e3e3e3e3e3e3e3e3e3e3e3e3e3e3e3e3e3e3e3e3e3e"
});
var c3 = new Counter(db3);

c1.onMilestone(async function(){
  console.log('db1 got ms');
  console.log(await c1.getCount());
});

c2.onMilestone(async function(){
  console.log('db2 got ms');
  console.log(await c2.getCount());
});

c3.onMilestone(async function(){
  console.log('db3 got ms');
  console.log(await c3.getCount());
});

var test = async function(){
  await db1.init();
  await db2.init();
  await db3.init();

  db1.startServer('1337', function () {
    db2.connectTo('localhost', '1337', function () {
      db3.connectTo('localhost', '1337', async function(){
        var id = await c2.increment();
        setTimeout(function(){
          db2.createMilestone('9475c6cf0eda34057528d8694781ecc92ad639d7e2bd27761ed3ef74924beb07',id);
        }, 500);
      });
    });
  });
};

test();