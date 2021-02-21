const LedgerGraph = require("./index.js");
const rimraf = require('rimraf');
const expect = require("chai").expect;
const fs = require('fs');

rimraf.sync('./test_db');
rimraf.sync('./test_db2');
rimraf.sync('./test_db3');

//scaffolding
var db1 = new LedgerGraph({
  base_state: { counter: 0 },
  store_path: "./test_db",
  private_key: "0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f"
});

var db2 = new LedgerGraph({
  base_state: { counter: 0 },
  store_path: "./test_db2",
  private_key: "2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c"
});

var db3 = new LedgerGraph({
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

db1.onMilestone('9475c6cf0eda34057528d8694781ecc92ad639d7e2bd27761ed3ef74924beb07', async function(){
  console.log('db1 got ms');
  var state = await db1.getState('9475c6cf0eda34057528d8694781ecc92ad639d7e2bd27761ed3ef74924beb07');
  console.log(state);
});

db2.onMilestone('9475c6cf0eda34057528d8694781ecc92ad639d7e2bd27761ed3ef74924beb07', async function(){
  console.log('db2 got ms');
  var state = await db2.getState('9475c6cf0eda34057528d8694781ecc92ad639d7e2bd27761ed3ef74924beb07');
  console.log(state);
});

db3.onMilestone('9475c6cf0eda34057528d8694781ecc92ad639d7e2bd27761ed3ef74924beb07', async function(){
  console.log('db3 got ms');
  var state = await db3.getState('9475c6cf0eda34057528d8694781ecc92ad639d7e2bd27761ed3ef74924beb07');
  console.log(state);
});

db1.onEvent(function(event){
  console.log('db1 got event', event.typ);
});
db2.onEvent(function(event){
  console.log('db2 got event', event.typ);
});
db3.onEvent(function(event){
  console.log('db3 got event', event.typ);
});

var test = async function(){
  await db1.init();
  await db2.init();
  await db3.init();

  db1.startServer('1337', function () {
    db2.connectTo('localhost', '1337', function () {
      db3.connectTo('localhost', '1337', async function(){
        var id = await db2.createEvent('increment',{},'9475c6cf0eda34057528d8694781ecc92ad639d7e2bd27761ed3ef74924beb07');
        console.log(id);
        setTimeout(function(){
          db2.createMilestone('9475c6cf0eda34057528d8694781ecc92ad639d7e2bd27761ed3ef74924beb07',id);
        }, 500);
      });
    });
  });
};

test();