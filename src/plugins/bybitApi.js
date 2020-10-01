import fetch from 'node-fetch';
import CryptoJS from 'crypto-js';
import ReconnectingWebSocket from 'reconnecting-websocket';
import HttpsProxyAgent from 'https-proxy-agent'

export default {
  install(Vue, defaultOptions = {}) {
    Vue.prototype.$bybitApi = new Vue({
      data: {
        account: {
          apiKey: '',
          apiSecret: '',
          label: '',
          isTestnet: false,
        },
        accounts: [],
        autoconnect: true,

        proxyUrl: '',
        removedOrdersMaxDays: 1,
        url: 'https://api.bybit.com/',
        wsUrl: 'wss://stream.bybit.com/realtime',
        ws: null,
        lastPrice: 0,
        markPrice: 0,
        walletBalance: 0,
        openOrders: [],
        openPosition: null,
        availableSymbols: ['BTCUSD', 'ETHUSD'],
        currentSymbol: 'BTCUSD',
        currentTickSize: 0.5,
        currentQtyStep: 1,
        urls: {
          mainnet: {
            url: 'https://api.bybit.com/',
            wsUrl: 'wss://stream.bybit.com/realtime',
          },
          testnet: {
            url: 'https://api-testnet.bybit.com/',
            wsUrl: 'wss://stream-testnet.bybit.com/realtime',
          },
        },
        positionInterval: undefined,
      },
      methods: {
        init() {
          if (this.ws) {
            this.ws.close();
          }
          if (this.account.apiKey && this.account.apiSecret &&
              this.autoconnect) {
            if (this.account.isTestnet) {
              this.url = this.urls.testnet.url;
              this.wsUrl = this.urls.testnet.wsUrl;
            } else {
              this.url = this.urls.mainnet.url;
              this.wsUrl = this.urls.mainnet.wsUrl;
            }
            this.initWs();
            this.updateInstrumentDetails();
            this.initPositionInterval();
            if (this.proxyUrl) {
              this.initGetOrdersInterval();
            } else {
              this.getOrders();
            }
          }
        },
        changeSymbol(symbol) {
          this.lastPrice = 0;
          this.markPrice = 0;
          this.walletBalance = 0;
          this.openOrders = [];
          this.openPosition = null;
          this.currentSymbol = symbol;
          this.init();
        },
        changeAccount() {
          this.lastPrice = 0;
          this.markPrice = 0;
          this.walletBalance = 0;
          this.openOrders = [];
          this.openPosition = null;
          this.init();
        },
        async updateInstrumentDetails() {
          const config = {}
          if (this.proxyUrl) {
            config.agent = new HttpsProxyAgent(this.proxyUrl);
          }

          const response = await fetch(this.url + 'v2/public/symbols', config);
          const json = await response.json();
          this.availableSymbols = json.result.map(el => el.name);
          if (json.ret_msg === 'OK') {
            let symbolInfos = json.result.find(
                el => el.name === this.currentSymbol);
            this.currentTickSize = parseFloat(
                symbolInfos.price_filter.tick_size);
            this.currentQtyStep = parseFloat(
                symbolInfos.lot_size_filter.qty_step);
          }
        },
        initWs() {
          this.ws = new ReconnectingWebSocket(`${this.wsUrl}`);

          this.ws.onopen = (e) => {
            let expires = Date.now() + 1500;

            let signature = CryptoJS.HmacSHA256('GET/realtime' + expires,
                this.account.apiSecret).
                toString();

            this.ws.send(
                JSON.stringify({
                  'op': 'auth',
                  'args': [this.account.apiKey, expires, signature],
                }));

            if (!this.proxyUrl) { // Get orders through the proxy
              setTimeout(() => {
                this.ws.send('{"op":"subscribe","args":["order"]}');
                // this.ws.send('{"op":"subscribe","args":["position"]}');
              }, 500);
            }
            this.ws.send(
                '{"op":"subscribe","args":["instrument_info.100ms.' +
                this.currentSymbol + '"]}');
          };

          this.ws.onmessage = (e) => {
            let data = JSON.parse(e.data);
            switch (data.topic) {
              case 'instrument_info.100ms.' + this.currentSymbol + '' :
                this.setPrice(data);
                break;
              case 'order' :
                for (let i = 0; i < data.data.length; i++) {
                  if (data.data[i].symbol === this.currentSymbol) {
                    if (data.data[i].order_status === 'Cancelled'
                        || data.data[i].order_status === 'Rejected'
                        || data.data[i].order_status === 'Filled') {
                      this.removeOrder(data.data[i]);
                    }
                    if (data.data[i].order_status === 'New'
                        || data.data[i].order_status === 'PartiallyFilled') {
                      this.addOrder(data.data[i]);
                    }
                  }
                }
                break;
              default :
                console.log(data);
                break;
            }
          };
        },
        setPrice(data) {
          if (data.type === 'snapshot') {
            this.lastPrice = Number(data.data.last_price_e4 + 'e-4').toFixed(2);
            this.markPrice = Number(data.data.mark_price_e4 + 'e-4').toFixed(2);
          }
          if (data.type === 'delta') {
            if (data.data.update[0].last_price_e4) {
              this.lastPrice = Number(
                  data.data.update[0].last_price_e4 + 'e-4').toFixed(2);
            }
            if (data.data.update[0].mark_price_e4) {
              this.markPrice = Number(
                  data.data.update[0].mark_price_e4 + 'e-4').toFixed(2);
            }
          }
        },
        initGetOrdersInterval() {
          if (this.getOrdersInterval) {
            this.disableGetOrdersInterval();
          }
          const self = this;
          this.getOrdersInterval = setInterval(this.getOrders, 1600);
          this.getCancelledOrdersInterval = setInterval(function() {
            self.getOrders(1, 'Cancelled,Rejected,Filled');
          }, 3000);
        },
        disableGetOrdersInterval() {
          clearInterval(this.getOrdersInterval);
          clearInterval(this.getCancelledOrdersInterval);
        },
        async getOrders(page = 1, order_status = 'New,PartiallyFilled') {
          try {
            let data = {
              'order_status': order_status,
              'symbol': this.currentSymbol,
              'page': page,
              'limit': 50
            };
            let url = new URL(this.url + 'open-api/order/list');
            url.search = new URLSearchParams(this.signData(data));

            const config = {}
            if (this.proxyUrl) {
              config.agent = new HttpsProxyAgent(this.proxyUrl);
            }

            const response = await fetch(url, config);
            const json = await response.json();
            if (json.ret_msg === 'ok') {
              let removed_orders_updated_at = null;
              if (json.result.data) {
                let data = json.result.data;
                // this.openOrders = this.openOrders.concat(json.result.data);
                for (let i = 0; i < data.length; i++) {
                  if (data[i].symbol === this.currentSymbol) {
                    if (data[i].order_status === 'Cancelled'
                        || data[i].order_status === 'Rejected'
                        || data[i].order_status === 'Filled') {
                      this.removeOrder(data[i]);
                      removed_orders_updated_at = data[i].updated_at;
                    }
                    if (data[i].order_status === 'New'
                        || data[i].order_status === 'PartiallyFilled') {
                      this.addOrder(data[i]);
                    }
                  }
                }
              }
              if (json.result.last_page > page &&
                (!removed_orders_updated_at ||
                  new Date(removed_orders_updated_at) >
                  new Date(new Date().setDate(
                    new Date().getDate()-this.removedOrdersMaxDays
                  )))) {
                await this.getOrders(page + 1);
              }
            } else {
              console.error(json);
              this.$notify({
                text: json.ret_msg,
                type: 'error',
              });
            }
          } catch (e) {
            console.error(e);
          }
        },
        initPositionInterval() {
          if (this.positionInterval) {
            this.disablePositionInterval();
          }
          this.positionInterval = setInterval(this.getPosition, 1100);
        },
        disablePositionInterval() {
          clearInterval(this.positionInterval);
        },
        async getPosition() {
          try {
            let data = {};
            let url = new URL(this.url + 'position/list');
            url.search = new URLSearchParams(this.signData(data));

            const config = {}
            if (this.proxyUrl) {
              config.agent = new HttpsProxyAgent(this.proxyUrl);
            }

            const response = await fetch(url, config);
            const json = await response.json();
            if (json.ret_msg === 'ok') {
              // console.log(json.result.filter(pos => pos.symbol === this.currentSymbol && pos.size > 0)) ;
              // console.log(json) ;
              this.walletBalance = json.result.filter(
                  pos => pos.symbol === this.currentSymbol)[0].wallet_balance;
              this.openPosition = json.result.filter(
                  pos => pos.symbol === this.currentSymbol && pos.size > 0)[0];
            } else {
              console.error(json);
              this.$notify({
                text: json.ret_msg +
                    ((json.ret_code === 10002) ? '<br> server_time : ' +
                        json.time_now + '<br> request_time : ' +
                        data.timestamp : ''),
                type: 'error',
              });
            }
          } catch (e) {
            console.error(e);
          }
        },
        marketClosePosition() {
          this.placeOrder({
            side: this.openPosition.side === 'Buy' ? 'Sell' : 'Buy',
            symbol: this.$bybitApi.currentSymbol,
            order_type: 'Market',
            qty: this.openPosition.size,
            time_in_force: 'GoodTillCancel',
          });
        },
        async setTradingStops(takeProfit, stopLoss, trailingStop) {
          let data = {
            symbol: this.currentSymbol,
            take_profit: takeProfit,
            stop_loss: stopLoss,
            trailing_stop: trailingStop,
          };
          let options = {
        		method: 'post',
        		body: JSON.stringify(this.signData(data)),
		        headers: {'Content-Type': 'application/json'}
          };
          if (this.proxyUrl) {
            options.agent = new HttpsProxyAgent(this.proxyUrl);
          }
          try {
            const response = await fetch(this.url + 'open-api/position/trading-stop', options);
            const json = await response.json();
            console.log(json);
            if (json.ret_msg === 'ok') {
              this.$notify({
                text: 'Trading stops changed',
                type: 'success',
              });
            } else {
              this.$notify({
                text: json.ret_msg,
                type: 'error',
              });
            }

          } catch (e) {
            console.error(e);
            this.$notify({
              text: e,
              type: 'error',
            });
          }
        },
        async placeOrder(data) {
          let options = {
        		method: 'post',
        		body:  JSON.stringify(this.signData(data)),
		        headers: {'Content-Type': 'application/json'}
          };
          if (this.proxyUrl) {
            options.agent = new HttpsProxyAgent(this.proxyUrl);
          }
          try {
            const response = await fetch(this.url + 'v2/private/order/create', options);
            const json = await response.json();
            //console.log(json);
            if (json.ret_msg === 'OK') {
              this.$notify({
                text: 'Order placed',
                type: 'success',
              });
            } else {
              this.$notify({
                text: json.ret_msg,
                type: 'error',
              });
            }

          } catch (e) {
            console.error(e);
            this.$notify({
              text: e,
              type: 'error',
            });
          }
        },
        async cancelOrder(id) {
          try {
            let data = {
              order_id: id,
              symbol: this.currentSymbol,
            };
            let options = {
          		method: 'post',
          		body: JSON.stringify(this.signData(data)),
  		        headers: {'Content-Type': 'application/json'}
            };
            if (this.proxyUrl) {
              options.agent = new HttpsProxyAgent(this.proxyUrl);
            }
            const response = await fetch(this.url + 'v2/private/order/cancel', options);
            const json = await response.json();
            if (json.ret_msg === 'OK') {
              this.$notify({
                text: 'Order cancelled',
                type: 'success',
              });
            } else {
              this.$notify({
                text: json.ret_msg,
                type: 'error',
              });
            }
          } catch (e) {
            console.error(e);
          }
        },
        async cancelAllOpenOrders() {
          try {
            let data = {
              symbol: this.currentSymbol,
            };
            let options = {
          		method: 'post',
          		body: JSON.stringify(this.signData(data)),
  		        headers: {'Content-Type': 'application/json'}
            };
            if (this.proxyUrl) {
              options.agent = new HttpsProxyAgent(this.proxyUrl);
            }
            const response = await fetch(this.url + 'v2/private/order/cancelAll', options);
            const json = await response.json();
            if (json.ret_msg === 'OK') {
              this.$notify({
                text: 'Orders cancelled',
                type: 'success',
              });
            } else {
              this.$notify({
                text: json.ret_msg,
                type: 'error',
              });
            }
          } catch (e) {
            console.error(e);
          }
        },
        async cancelAllBuyOpenOrders() {
          for (let i = 0; i < this.openOrders.length; i++) {
            if (this.openOrders[i].side === 'Buy') {
              this.cancelOrder(this.openOrders[i].order_id);
            }
          }
        },
        async cancelAllSellOpenOrders() {
          for (let i = 0; i < this.openOrders.length; i++) {
            if (this.openOrders[i].side === 'Sell') {
              this.cancelOrder(this.openOrders[i].order_id);
            }
          }
        },
        addOrder(order) {
          let exists = false;
          order.updated_at = order.timestamp;
          console.log(order, this.openOrders);
          for (let i = 0; i < this.openOrders.length; i++) {
            if (this.openOrders[i].order_id === order.order_id) {
              exists = true;
              this.$set(this.openOrders, i, order);
            }
          }
          if (!exists) {
            this.openOrders.push(order);
          }
        },
        removeOrder(order) {
          console.log(order, this.openOrders);
          for (let i = 0; i < this.openOrders.length; i++) {
            if (this.openOrders[i].order_id === order.order_id) {
              this.openOrders.splice(i, 1);
            }
          }
        },
        signData(data) {
          data.api_key = this.account.apiKey;
          data.timestamp = Date.now() - 2000;
          data.recv_window = 25000;
          let dataString = this.objToString(this.sortObject(data));
          data.sign = CryptoJS.HmacSHA256(dataString, this.account.apiSecret).
              toString();
          return this.sortObject(data);
        },
        sortObject(o) {
          let sorted = {},
              key,
              a = [];
          for (key in o) {
            if (o.hasOwnProperty(key)) {
              a.push(key);
            }
          }
          a.sort();
          for (key = 0; key < a.length; key++) {
            sorted[a[key]] = o[a[key]];
          }
          return sorted;
        },
        objToString(data) {
          return Object.keys(data).map(function(k) {
            return k + '=' + data[k];
          }).join('&');
        },
        getDataFromLocalStorage() {
          if (localStorage.accounts !== undefined) {
            this.accounts = JSON.parse(localStorage.accounts);
          }
          if (localStorage.account) {
            this.account = JSON.parse(localStorage.account);
          }
          if (localStorage.currentSymbol) {
            this.currentSymbol = localStorage.currentSymbol;
          }
          if (localStorage.autoconnect !== undefined) {
            this.autoconnect = localStorage.autoconnect === 'true';
          }
          if (localStorage.proxyUrl) {
            this.proxyUrl = localStorage.proxyUrl;
          }
        },
      },
      created() {
        this.getDataFromLocalStorage();
        this.init();
      },
      watch: {
        autoconnect(autoconnect) {
          localStorage.autoconnect = autoconnect;
        },
        apiKey(apiKey) {
          this.account.apiKey = apiKey.trim();
          localStorage.apiKey = apiKey.trim();
        },
        apiSecret(apiSecret) {
          this.apiSecret = apiSecret.trim();
          localStorage.apiSecret = apiSecret.trim();
        },
        currentSymbol(currentSymbol) {
          localStorage.currentSymbol = currentSymbol;
        },
        account: {
          deep: true,
          handler(account) {
            account.apiSecret = account.apiSecret.trim();
            account.label = account.label.trim();
            account.apiKey = account.apiKey.trim();
            localStorage.account = JSON.stringify(account);
          },
        },
        accounts: {
          deep: true,
          handler(accounts) {
            localStorage.accounts = JSON.stringify(accounts);
          },
        },
        proxyUrl(proxyUrl) {
          localStorage.proxyUrl = proxyUrl;
        }
      },
    });
  },
};
