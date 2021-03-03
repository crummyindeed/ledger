function Counter(Graph){
  this.Graph = Graph;
  this.authority = '9475c6cf0eda34057528d8694781ecc92ad639d7e2bd27761ed3ef74924beb07';
  this.base_state = {
    counter: 0
  }
  this.reducers = {
    "increment": (state, issuer, payload, digest) => {
      state.counter++;
    },
    "decrement": (state, issuer, payload, digest) => {
      state.counter--;
    }
  };
}
Counter.prototype.onMilestone = function(callBack){
  this.Graph.onMilestone(this.authority, callBack);
}
Counter.prototype.getState = function(){
  return this.Graph.getStateCustom(this.authority, this.base_state, this.reducers);
};
Counter.prototype.getCount = async function(){
  var state = await this.getState();
  return state.counter;
}
Counter.prototype.increment = function(){
  return this.Graph.createEvent('increment',{},this.authority);
}
Counter.prototype.decrement = function(){
  return this.Graph.createEvent('decrement',{},this.authority);
}

module.exports = Counter;