var https = require('https');
var http = require('http');
var tokens = require("./tokens.json");
var config = require("./config.json");
var ethexABI = require("./ethexABI");
var abiDecode = require("./abi-decoder");
var tokenMap = {};
for (var token of tokens) {
    tokenMap[token.address.toLowerCase()] = token;
}
abiDecode.addABI(ethexABI);

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
        var startBlock = lastBlock - blocksPer24Hours;
        var startBlock = "0x" + startBlock.toString(16);
        var lastBlock = "0x" + lastBlock.toString(16);
        rpcCall("eth_getLogs", [{ "fromBlock": startBlock, "toBlock": lastBlock, "address": "0xb746aed479f18287dc8fc202fe06f25f1a0a60ae" }], (results) => {
            var logs = abiDecode.decodeLogs(results['result']);
            for (var log of logs) {
                //initialize
                var tokenData = { last: null, lowestAsk: null, highestBid: null, volume: 0, high24hr: null, low24hr: null };
                var tokenAddress = null;
                var token = null;
                if (log.name === "MakeSellOrder" || log.name === "MakeBuyOrder" || log.name === "TakeSellOrder" || log.name === "TakeBuyOrder") {
                    for (var event of log.events) {
                        if (event.name === "token") {
                            tokenAddress = event.value;
                        }
                    }
                    if (!marketData[tokenAddress]) {
                        marketData[tokenAddress] = tokenData;
                    } else {
                        tokenData = marketData[tokenAddress];
                    }
                    token = tokenMap[tokenAddress];
                    if (token === undefined) {
                        console.log("undefined!!!", tokenAddress);
                    } else {
                    }
                    var tokenAmount;
                    var weiAmount;
                    for (var event of log.events) {
                        if (event.name === "tokenAmount")
                            tokenAmount = event.value;
                        if (event.name === "weiAmount")
                            weiAmount = event.value;
                    }
                    var weiPerToken = parseFloat(weiAmount) / parseFloat(tokenAmount);
                    var adjust = 18 - parseInt(token.decimals);
                    var price = weiPerToken * Math.pow(10, -adjust);

                    if (log.name === "MakeSellOrder") { //ask
                        if (tokenData.lowestAsk === null || price < tokenData.lowestAsk) {
                            tokenData.lowestAsk = price;
                        }
                    }
                    if (log.name === "MakeBuyOrder") { //bid
                        if (tokenData.highestBid === null || price > tokenData.highestBid) {
                            tokenData.highestBid = price;
                        }
                    }
                    if (log.name.startsWith("Take")) {
                        tokenData.last = price;
                        if (tokenData.high24hr === null || price > tokenData.high24hr)
                            tokenData.high24hr = price;
                        if (tokenData.low24hr === null || price < tokenData.low24hr)
                            tokenData.high24hr = price;
                    }
                    if (log.name === "TakeSellOrder") { //last price,volume,high24hr,low24hr
                        for (var event of log.events) {
                            if (event.name === "totalTransactionWei") {
                                var vol = parseInt(event.value) / Math.pow(10, 18);
                                tokenData.volume += vol;
                            }
                        }
                    }
                    if (log.name === "TakeBuyOrder") { //last price,volume,high24hr,low24hr
                        for (var event of log.events) {
                            if (event.name === "totalTransactionTokens") {
                                var dec = parseInt(token.decimals);
                                var tok = parseInt(event.value) / Math.pow(10, dec);
                                var vol = tok * price;
                                tokenData.volume += vol;
                            }
                        }
                    }
                    //tokenData and tokenAddress are now initialized.
                }

            }
            marketDataCallback(marketData);
        });
    });
    
}
var MarketData = {};
var refresh24Hour = () => {
    getMarketData((marketData)=>{
        MarketData = marketData;
    });
}

var server = http.createServer(function (req, res) {
    // You can define here your custom logic to handle the request
    // and then proxy the request.
    //application/json-rpc
    if (req.method == 'GET') {
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS, PUT, PATCH, DELETE'); // If needed
        res.setHeader('Access-Control-Allow-Headers', 'X-Requested-With,content-type'); // If needed
        res.setHeader('Content-Type', 'application/json');
        var results = {};
        for (var address in MarketData) {
            var token = tokenMap[address];
            if (token) {
                var pair = "ETH_"+token.symbol;
                results[pair] = MarketData[address];
            }
        }
        res.write(JSON.stringify(results));
        res.end();
        return;
    }
    else if (req.method == 'POST') {
    }
});

getMarketData((marketData)=>{
    MarketData = marketData;
    server.listen(5055);
});
setInterval(refresh24Hour,30*1000);


