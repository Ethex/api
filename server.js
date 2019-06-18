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
var globalBlockNum; //global version for the latest block to ensure API only updates when a new block comes in
abiDecode.addABI(ethexABI);

var minWei;
let args = process.argv;
if (args[2] === '0') {
  minWei = new BigNumber(0);
}
else {
  minWei = new BigNumber(0.001).times(Math.pow(10, 18));
}


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
    console.log('RPC Error: ', e);
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
    if (!globalBlockNum || globalBlockNum < parseInt(results.result)) {
      var lastBlock = parseInt(results.result);
      globalBlockNum = lastBlock;
      var startBlock = 4078264;
      var rangeBlock = lastBlock - blocksPer24Hours;
      var startBlock = "0x" + startBlock.toString(16);
      var lastBlock = "0x" + lastBlock.toString(16);
      rpcCall("eth_getLogs", [{ "fromBlock": startBlock, "toBlock": lastBlock, "address": config.contract_address }], (results) => {
        var logs = abiDecode.decodeLogs(results['result']);
        var _openSells = {};
        var _openBuys = {};
        for (var log_idx in logs) {
          //initialize
          var log = logs[log_idx];

          var tx = results['result'][log_idx];
          var tokenData = { last: null, lowestAsk: null, highestBid: null, volume: new BigNumber(0), high24hr: null, low24hr: null };
          var tokenAddress = null;
          var token = null;
          var tokAmount;
          var weiAmount;
          var orderHash;
          var maker;
          var orgTokAmount;
          var orgWeiAmount;

          if (log.name === "MakeSellOrder" ||
            log.name === "MakeBuyOrder" ||
            log.name === "TakeSellOrder" ||
            log.name === "TakeBuyOrder" ||
            log.name === "CancelBuyOrder" ||
            log.name === "CancelSellOrder" ||
            log.name === "ChangeBuyOrder" ||
            log.name === "ChangeSellOrder") {
            tokenAddress = null;
            for (var event of log.events) {
              if (event.name === "token") {
                tokenAddress = event.value;
              }
              if (event.name === "tokenAmount") {
                tokAmount = new BigNumber(event.value);
              }
              if (event.name === "weiAmount") {
                weiAmount = new BigNumber(event.value);
              }
              if (event.name === "orderHash") {
                orderHash = event.value;
              }
              if (event.name === "buyer") {
                maker = event.value;
              }
              if (event.name === "seller") {
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
              var order = { type: log.name, tokenAddress, price, weiPerTok, weiAmount, tokAmount, orgTokAmount: !orgTokAmount ? tokAmount : orgTokAmount, orgWeiAmount: !orgWeiAmount ? weiAmount : orgWeiAmount, maker };
              _openSells[orderHash] = order;
            }
            if (log.name === "MakeBuyOrder") { //bid
              var order = { type: log.name, tokenAddress, price, weiPerTok, weiAmount, tokAmount, orgTokAmount: !orgTokAmount ? tokAmount : orgTokAmount, orgWeiAmount: !orgWeiAmount ? weiAmount : orgWeiAmount, maker };
              _openBuys[orderHash] = order;
            }
            if (log.name === "ChangeSellOrder") { //ask
              var oldHash = log.events[0].value;
              var order = { type: log.name, tokenAddress, price, weiPerTok, weiAmount, tokAmount, orgTokAmount: !orgTokAmount ? tokAmount : orgTokAmount, orgWeiAmount: !orgWeiAmount ? weiAmount : orgWeiAmount, maker };
              _openSells[orderHash] = order;
              delete _openSells[oldHash];
            }
            if (log.name === "ChangeBuyOrder") { //bid
              var oldHash = log.events[0].value;
              var order = { type: log.name, tokenAddress, price, weiPerTok, weiAmount, tokAmount, orgTokAmount: !orgTokAmount ? tokAmount : orgTokAmount, orgWeiAmount: !orgWeiAmount ? weiAmount : orgWeiAmount, maker };
              _openBuys[orderHash] = order;
              delete _openBuys[oldHash];
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
                  if (_openSells[orderHash]) {
                    order = _openSells[orderHash];
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
                  if (_openBuys[orderHash]) {
                    order = _openBuys[orderHash];
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
              delete _openBuys[orderHash];
            }
            if (log.name === "CancelSellOrder") {
              delete _openSells[orderHash];
            }
            //tokenData and tokenAddress are now initialized.
          }

        }
        clearEmptyOrders(_openBuys, marketData);
        clearEmptyOrders(_openSells, marketData);
        // reset global orders to make sure canceled and completed orders do not get picked up.
        ethOpenSells = {};
        ethOpenBuys = {};
        formatOrder(_openBuys);
        formatOrder(_openSells);
        marketDataCallback(marketData, ethOpenBuys, ethOpenSells);
      });
    }
  });
}
var MarketData = {};
var openBuys = {};
var openSells = {};
var ethOpenBuys = {};
var ethOpenSells = {};
var clearEmptyOrders = (openOrders, marketData) => {
  for (hash in openOrders) {
    var openOrder = openOrders[hash];
    if (openOrder.weiAmount.lte(minWei)) {
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
}
var formatOrder = (orders) => {

  for (hash in orders) {
    var openOrder = orders[hash];
    var type = "Buy";
    if (openOrder.type === "MakeBuyOrder" || openOrder.type === "ChangeBuyOrder") {
      type = "Sell";
    }
    var specifiedOpenOrders;
    if (type === "Buy") {
      specifiedOpenOrders = ethOpenSells;
    }
    else {
      specifiedOpenOrders = ethOpenBuys;
    }
    var token = tokenMap[openOrder.tokenAddress];
    if (token) {
      specifiedOpenOrders[hash] = {
        type: type,
        priceEth: openOrder.price,
        tokenAmount: openOrder.tokAmount.dividedBy(Math.pow(10, token.decimals)),
        ethAmount: openOrder.weiAmount.dividedBy(Math.pow(10, 18)),
        tokenAddress: openOrder.tokenAddress,
        symbol: token.symbol,
        orgTokenAmount: openOrder.orgTokAmount.dividedBy(Math.pow(10, token.decimals)),
        orgEthAmount: openOrder.orgWeiAmount.dividedBy(Math.pow(10, 18)),
        maker: openOrder.maker
      }
    }
  }
}
var refresh24Hour = () => {
  getMarketData((marketData, _openBuys, _openSells) => {
    MarketData = marketData;
    openBuys = _openBuys;
    openSells = _openSells;
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
      var results = [];
      for (var hash in openBuys) {
        var openOrder = openBuys[hash];
        var token = tokenMap[openOrder.tokenAddress];
        if (token) {
          var pair = "ETH_" + token.symbol;
          openOrder.pair = pair;
          openOrder.hash = hash;
          results.push(openOrder);
        }
      }
      for (var hash in openSells) {
        var openOrder = openSells[hash];
        var token = tokenMap[openOrder.tokenAddress];
        if (token) {
          var pair = "ETH_" + token.symbol;
          openOrder.pair = pair;
          openOrder.hash = hash;
          results.push(openOrder);
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
getMarketData((marketData, _openBuys, _openSells) => {
  MarketData = marketData;
  openBuys = _openBuys;
  openSells = _openSells;
  server.once('error', function (err) {
    if (err.code === 'EADDRINUSE') {
      console.log('Port is already in use. Make sure you can see open orders on localhost:5055/openOrders.');
    }
  });
  server.listen(config.server_port);
  console.log("listening on", config.server_port);
});
setInterval(refresh24Hour, 15 * 1000);