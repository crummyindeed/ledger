# Crummy Ledger

Crummy Ledger is a Node JS module for creating distributed ledgers. Important features include:
- Fully NodeJS (no built dependancies)
- Fully Decentralized (no coordinators - no miners)
- Byzantine Fault Tolerant (secure up to 1/2 faulty/dishonest, able to progress up to 1/3 faulty/dishonest)

Currently UNLICENSED - working on appropriate liscensing

## Basic Documentation

```
npm install crummyledger
```

```javascript
const Ledger = require("crummyledger");

async function main(){
  //initialize a distributed database with a base state, a directory for storing events locally, and a private key 
  var database = new Ledger({
    base_state: { counter: 0 },
    store_path: "./test_db",
    private_key: "0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f"
  });

  //Reducers define how different events effect the overall state
  database.setReducer('increment', function (state, issuer, payload) {
    state.counter++;
  });
  database.setReducer('add', function (state, issuer, payload) {
    state.counter += payload.amount;
  });

  //subscribe to milestone events to get notified of state changes
  database.onMilestone(async function () {
    console.log(await database.getState());
  });

  await database.init();

  //connect to tpeers to join the network
  database.connectTo(hostname_or_ipaddress, port, function () {
    console.log('connnected to a peer!');
  });

  //open a socket for incoming connections if you want others to be able to connect to you
  database.startServer(local_port, function () {
    console.log('I\'m ready for connections!');
  });

  //when you're all done
  database shutDown();
}

main();

```