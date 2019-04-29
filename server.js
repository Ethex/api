var https = require('https');
var http = require('http');
var tokens = require("./tokens.json");
var config = require("./config.json");
var ethexABI = require("./ethexABI");
var abiDecode = require("abi-decoder");
var BigNumber = require('bignumber.js');
const fs = require('fs');
var docs = fs.readFileSync("./docs.html");
var tokenMap = {};
for (var token of tokens) {
  tokenMap[token.address.toLowerCase()] = token;
}
abiDecode.addABI(ethexABI);
var minWei = new BigNumber(0.001).times(Math.pow(10, 18));

var rpcCall = (method, params, result_callback) => {
  var optionspost = {
    host: config.node_host,
    port: config.node_port,
    path: '/',
    method: 'POST',
    headers: { 'Content-Type': 'application/json' }
  };
  var data = "";
  var req = https.request(optionspost, (res) => {
    res.on('data', (chunk) => {
      data += chunk;
    });
    res.on('end', () => {
      result_callback(JSON.parse(data));
    });
  }).on('error', (e) => {
    result_callback(null);
  });
  var params_str = JSON.stringify(params);
  var post = '{"jsonrpc":"2.0","method":"' + method + '","params":' + params_str + ',"id":74}';
  req.write(post);
  req.end();
}


var getMarketData = (marketDataCallback) => {
  var marketData = {}; //last,lowestAsk,highestBid,volume,high24hr,low24hr
  var blocksPer24Hours = (60 * 60 * 24) / 14.5;  //14.5 seconds per blocks on average. might need to be adjusted depending on blocktime.
  rpcCall("eth_blockNumber", [], (results) => {
    var lastBlock = parseInt(results.result);
    var startBlock = 4078264;
    var rangeBlock = lastBlock - blocksPer24Hours;
    var startBlock = "0x" + startBlock.toString(16);
    var lastBlock = "0x" + lastBlock.toString(16);
    rpcCall("eth_getLogs", [{ "fromBlock": startBlock, "toBlock": lastBlock, "address": config.contract_address }], (results) => {
      var logs = abiDecode.decodeLogs(results['result']);
      var openOrders = {};
      for (var log_idx in logs) {
        //initialize
        var log = logs[log_idx];

        var tx = results['result'][log_idx]
        var tokenData = { last: null, lowestAsk: null, highestBid: null, volume: new BigNumber(0), high24hr: null, low24hr: null };
        var tokenAddress = null;
        var token = null;
        var tokAmount;
        var weiAmount;
        var orderHash;
        var maker;
        if (log.name === "MakeSellOrder" ||
          log.name === "MakeBuyOrder" ||
          log.name === "TakeSellOrder" ||
          log.name === "TakeBuyOrder" ||
          log.name === "CancelBuyOrder" ||
          log.name === "CancelSellOrder") {
          tokenAddress = null;
          for (var event of log.events) {
            if (event.name === "token") {
              tokenAddress = event.value;
            }
            if (event.name === "tokenAmount"){
              tokAmount = new BigNumber(event.value);
            }
            if (event.name === "weiAmount"){
              weiAmount = new BigNumber(event.value);
            }
            if (event.name === "orderHash") {
              orderHash = event.value;
            }
            if(event.name === 'buyer'){
              maker = event.value;
            }
            if(event.name === 'seller'){
              maker = event.value;
            }
          }
          if (!marketData[tokenAddress]) {
            marketData[tokenAddress] = tokenData;
          } else {
            tokenData = marketData[tokenAddress];
          }
          token = tokenMap[tokenAddress];
          var weiPerTok = weiAmount.dividedBy(tokAmount);
          var price = null;
          if (token)
            price = weiPerTok.dividedBy(Math.pow(10, 18 - token.decimals));//ETH per full token
          if (log.name === "MakeSellOrder") { //ask
            var order = { type: log.name, tokenAddress, price, weiPerTok, weiAmount, tokAmount, maker };
            openOrders[orderHash] = order;
          }
          if (log.name === "MakeBuyOrder") { //bid
            var order = { type: log.name, tokenAddress, price, weiPerTok, weiAmount, tokAmount, maker };
            openOrders[orderHash] = order;
          }
          if (log.name.startsWith("Take") && tx.blockNumber >= rangeBlock) {
            tokenData.last = price;
            if (tokenData.high24hr === null || price.isGreaterThan(tokenData.high24hr))
              tokenData.high24hr = price;
            if (tokenData.low24hr === null || price.isLessThan(tokenData.low24hr))
              tokenData.low24hr = price;
          }
          if (log.name === "TakeSellOrder") { //last price,volume,high24hr,low24hr

            for (var event of log.events) {
              if (event.name === "totalTransactionWei") {
                var totalTransactionWei = new BigNumber(event.value);
                if (openOrders[orderHash]) {
                  order = openOrders[orderHash];
                  order.weiAmount = order.weiAmount.minus(totalTransactionWei);
                  order.tokAmount = order.tokAmount.minus(totalTransactionWei.dividedBy(weiPerTok));
                  if (tx.blockNumber >= rangeBlock)
                    tokenData.volume = tokenData.volume.plus(totalTransactionWei.dividedBy(Math.pow(10, 18)));
                }
              }
            }
          }
          if (log.name === "TakeBuyOrder") { //last price,volume,high24hr,low24hr
            for (var event of log.events) {
              if (event.name === "totalTransactionTokens") {
                var totalTransactionTokens = new BigNumber(event.value);
                if (openOrders[orderHash]) {
                  order = openOrders[orderHash];
                  var totalTransactionWei = totalTransactionTokens.times(weiPerTok);
                  order.tokAmount = order.tokAmount.minus(totalTransactionTokens);
                  order.weiAmount = order.weiAmount.minus(totalTransactionTokens.times(weiPerTok));
                  if (tx.blockNumber >= rangeBlock)
                    tokenData.volume = tokenData.volume.plus(totalTransactionWei.dividedBy(Math.pow(10, 18)));
                }
              }
            }
          }
          if (log.name === "CancelBuyOrder") {
            delete openOrders[orderHash];
          }
          if (log.name === "CancelSellOrder") {
            delete openOrders[orderHash];
          }
          //tokenData and tokenAddress are now initialized.
        }

      }
      //openOrders is the entire order book.
      for (hash in openOrders) {
        var openOrder = openOrders[hash];
        if (openOrder.weiAmount.isLessThan(minWei)) {
          delete openOrders[hash];
          continue;
        }
        token = tokenMap[openOrder.tokenAddress];
        tokenData = marketData[openOrder.tokenAddress];
        if (openOrder.type === "MakeSellOrder" && (tokenData.lowestAsk === null || tokenData.lowestAsk.isGreaterThan(openOrder.price))) {
          tokenData.lowestAsk = openOrder.price;
        }
        if (openOrder.type === "MakeBuyOrder" && (tokenData.highestBid === null || tokenData.highestBid.isLessThan(openOrder.price))) {
          tokenData.highestBid = openOrder.price;
        }
      }
      //format for eth
      var ethOpenOrders = {};
      for (hash in openOrders) {
        var openOrder = openOrders[hash];
        var type = "Buy";
        if (openOrder.type === "MakeBuyOrder") {
          type = "Sell";
        }
        var token = tokenMap[openOrder.tokenAddress];
        if (token) {
          ethOpenOrders[hash] = {
            type: type,
            priceEth: openOrder.price,
            tokenAmount: openOrder.tokAmount.dividedBy(Math.pow(10, token.decimals)),
            ethAmount: openOrder.weiAmount.dividedBy(Math.pow(10, 18)),
            tokenAddress: openOrder.tokenAddress,
            symbol: token.symbol,
            maker: openOrder.maker
          };
        } else {
        }
      }
      marketDataCallback(marketData, ethOpenOrders);
    });
  });
}
var MarketData = {};
var OpenOrders = {};
var refresh24Hour = () => {
  getMarketData((marketData, openOrders) => {
    MarketData = marketData;
    OpenOrders = openOrders;
  });
}

var server = http.createServer(function (req, res) {
  if (req.method == "GET" && req.url == "/") {
    res.write(docs);
    res.end();
    return;
  }
  if (req.method == 'GET') {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS, PUT, PATCH, DELETE'); // If needed
    res.setHeader('Access-Control-Allow-Headers', 'X-Requested-With,content-type'); // If needed
    res.setHeader('Content-Type', 'application/json');
    if (req.url === "/ticker24") {
      var results = {};
      for (var address in MarketData) {
        var token = tokenMap[address];
        if (token) {
          var pair = "ETH_" + token.symbol;
          results[pair] = MarketData[address];
        }
      }
      res.write(JSON.stringify(results, undefined, 2));
      res.end();
      return;
    }
    else if (req.url === "/openOrders") {
      var results = {};
      for (var hash in OpenOrders) {
        var openOrder = OpenOrders[hash];
        var token = tokenMap[openOrder.tokenAddress];
        if (token) {
          var pair = "ETH_" + token.symbol;
          openOrder.pair = pair;
          openOrder.hash = hash;
          results[hash] = OpenOrders[hash];
        }
      }
      res.write(JSON.stringify(results, undefined, 2));
      res.end();
      return;
    }
    else {
      res.write(docs);
      res.end();
      return;
    }
  }
});
console.log("starting api server");
getMarketData((marketData, openOrders) => {
  MarketData = marketData;
  OpenOrders = openOrders;
  server.listen(config.server_port);
  console.log("listening on", config.server_port);
});
setInterval(refresh24Hour, 30 * 1000);


