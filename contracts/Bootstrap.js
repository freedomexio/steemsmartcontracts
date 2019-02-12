const { Base64 } = require('js-base64');
const { Transaction } = require('../libs/Transaction');
const BP_CONSTANTS = require('../libs/BlockProduction.contants').CONSTANTS;

class Bootstrap {
  static getBootstrapTransactions(genesisSteemBlock) {
    const transactions = [];

    let contractCode;
    let base64ContractCode;
    let contractPayload;

    // tokens contract
    contractCode = `
    actions.createSSC = async (payload) => {
      await db.createTable('tokens', ['symbol']);
      await db.createTable('balances', ['account']);
      await db.createTable('contractsBalances', ['account']);
      await db.createTable('params');

      const params = {};
      params.tokenCreationFee = 0;
      await db.insert('params', params);  
    }

    actions.updateParams = async (payload) => {
      if (sender !== owner) return;

      const { tokenCreationFee } = payload;

      const params = await db.findOne('params', { });

      params.tokenCreationFee = tokenCreationFee;

      await db.update('params', params);
    }

    actions.updateUrl = async (payload) => {
      const { url, symbol } = payload;

      if (assert(symbol && typeof symbol === 'string'
          && url && typeof url === 'string', 'invalid params')
          && assert(url.length <= 255, 'invalid url: max length of 255')) {
        // check if the token exists
        let token = await db.findOne('tokens', { symbol });

        if (token) {
          if(assert(token.issuer === sender, 'must be the issuer')) {
            token.url = url;
            await db.update('tokens', token);
          }
        }
      }
    }

    actions.create = async (payload) => {
      const { name, symbol, url, precision, maxSupply, isSignedWithActiveKey } = payload;

      // get contract params
      const params = await db.findOne('params', { });
      const { tokenCreationFee } = params;

      // get sender's UTILITY_TOKEN_SYMBOL balance
      const utilityTokenBalance = await db.findOne('balances', { account: sender, symbol: "${BP_CONSTANTS.UTILITY_TOKEN_SYMBOL}" });

      const authorizedCreation = tokenCreationFee <= 0 ? true : utilityTokenBalance && utilityTokenBalance.balance >= tokenCreationFee;

      if (assert(authorizedCreation, 'you must have enough tokens to cover the creation fees')
        && assert(name && typeof name === 'string'
        && symbol && typeof symbol === 'string'
        && (url === undefined || (url && typeof url === 'string'))
        && (precision && typeof precision === 'number' || precision === 0)
        && maxSupply && typeof maxSupply === 'number', 'invalid params')) {

        // the precision must be between 0 and 8 and must be an integer
        // the max supply must be positive
        if (assert(validator.isAlpha(symbol) && validator.isUppercase(symbol) && symbol.length > 0 && symbol.length <= 10, 'invalid symbol: uppercase letters only, max length of 10')
          && assert(validator.isAlphanumeric(validator.blacklist(name, ' ')) && name.length > 0 && name.length <= 50, 'invalid name: letters, numbers, whitespaces only, max length of 50')
          && assert(url === undefined || url.length <= 255, 'invalid url: max length of 255')
          && assert((precision >= 0 && precision <= 8) && (Number.isInteger(precision)), 'invalid precision')
          && assert(maxSupply > 0, 'maxSupply must be positive')
          && assert(maxSupply <= 1000000000000, 'maxSupply must be lower than 1000000000000')) {

          // check if the token already exists
          let token = await db.findOne('tokens', { symbol });

          if (assert(token === null, 'symbol already exists')) {
            const newToken = {
              issuer: sender,
              symbol,
              name,
              url,
              precision,
              maxSupply,
              supply: 0
            };
            
            await db.insert('tokens', newToken);

            // burn the token creation fees
            if (tokenCreationFee > 0) {
              await actions.transfer({ to: 'null', symbol: "${BP_CONSTANTS.UTILITY_TOKEN_SYMBOL}", quantity: tokenCreationFee, isSignedWithActiveKey });
            }
          }
        }
      }
    }

    actions.issue = async (payload) => {
      const { to, symbol, quantity, isSignedWithActiveKey } = payload;

      if (assert(isSignedWithActiveKey === true, 'you must use a custom_json signed with your active key')
        && assert(to && typeof to === 'string'
        && symbol && typeof symbol === 'string'
        && quantity && typeof quantity === 'number', 'invalid params')) {

        let token = await db.findOne('tokens', { symbol });

        // the symbol must exist
        // the sender must be the issuer
        // then we need to check that the quantity is correct
        if (assert(token !== null, 'symbol does not exist')
          && assert(token.issuer === sender, 'not allowed to issue tokens')
          && assert(countDecimals(quantity) <= token.precision, 'symbol precision mismatch')
          && assert(quantity > 0, 'must issue positive quantity')
          && assert(quantity <= (BigNumber(token.maxSupply).minus(token.supply).toNumber()), 'quantity exceeds available supply')) {

          // a valid steem account is between 3 and 16 characters in length
          if (assert(to.length >= 3 && to.length <= 16, 'invalid to')) {
            // we made all the required verification, let's now issue the tokens

            token.supply = calculateBalance(token.supply, quantity, token.precision, true);
            
            await db.update('tokens', token);

            let res = await addBalance(token.issuer, token, quantity, 'balances');

            if (res === true && to !== token.issuer) {
              if (await subBalance(token.issuer, token, quantity, 'balances')) {
                res = await addBalance(to, token, quantity, 'balances');

                if (res === false) {
                  await addBalance(token.issuer, token, quantity, 'balances');
                }
              }
            }

            emit('transferFromContract', { from: 'tokens', to, symbol, quantity });
          }
        }
      }
    }

    actions.transfer = async (payload) => {
      const { to, symbol, quantity, isSignedWithActiveKey } = payload;

      if (assert(isSignedWithActiveKey === true, 'you must use a custom_json signed with your active key')
        && assert(to && typeof to === 'string'
        && symbol && typeof symbol === 'string'
        && quantity && typeof quantity === 'number', 'invalid params')) {

        if (assert(to !== sender, 'cannot transfer to self')) {
          // a valid steem account is between 3 and 16 characters in length
          if (assert(to.length >= 3 && to.length <= 16, 'invalid to')) {
            let token = await db.findOne('tokens', { symbol });

            // the symbol must exist
            // then we need to check that the quantity is correct
            if (assert(token !== null, 'symbol does not exist')
              && assert(countDecimals(quantity) <= token.precision, 'symbol precision mismatch')
              && assert(quantity > 0, 'must transfer positive quantity')) {

              if (await subBalance(sender, token, quantity, 'balances')) {
                const res = await addBalance(to, token, quantity, 'balances');

                if (res === false) {
                  await addBalance(sender, token, quantity, 'balances');

                  return false;
                }

                emit('transfer', { from: sender, to, symbol, quantity });

                return true;
              }
            }
          }
        }
      }

      return false;
    }

    actions.transferToContract = async (payload) => {
      const { to, symbol, quantity, isSignedWithActiveKey } = payload;

      if (assert(isSignedWithActiveKey === true, 'you must use a custom_json signed with your active key')
        && assert(to && typeof to === 'string'
        && symbol && typeof symbol === 'string'
        && quantity && typeof quantity === 'number', 'invalid params')) {

        if (assert(to !== sender, 'cannot transfer to self')) {
          let contract = await db.findContract(to);
    
          // a valid contract account is between 3 and 50 characters in length
          if (assert(to.length >= 3 && to.length <= 50, 'invalid to')) {
            let token = await db.findOne('tokens', { symbol });

            // the symbol must exist
            // then we need to check that the quantity is correct
            if (assert(token !== null, 'symbol does not exist')
              && assert(countDecimals(quantity) <= token.precision, 'symbol precision mismatch')
              && assert(quantity > 0, 'must transfer positive quantity')) {

              if (await subBalance(sender, token, quantity, 'balances')) {
                const res = await addBalance(to, token, quantity, 'contractsBalances');

                if (res === false) {
                  await addBalance(sender, token, quantity, 'balances');
                } else {
                  emit('transferToContract', { from: sender, to, symbol, quantity });
                }
              }
            }
          }
        }
      }
    }

    actions.transferFromContract = async (payload) => {
      // this action can only be called by the 'null' account which only the core code can use
      if (assert(sender === 'null', 'not authorized')) {
        const { from, to, symbol, quantity, type, isSignedWithActiveKey } = payload;
        const types = ['user', 'contract'];

        if (assert(isSignedWithActiveKey === true, 'you must use a custom_json signed with your active key')
          && assert(to && typeof to === 'string'
          && from && typeof from === 'string'
          && symbol && typeof symbol === 'string'
          && type && (types.includes(type))
          && quantity && typeof quantity === 'number', 'invalid params')) {

          const table = type === 'user' ? 'balances' : 'contractsBalances';

          if (assert(type === 'user' || ( type === 'contract' && to !== from), 'cannot transfer to self')) {
            // validate the "to"
            let toValid = type === 'user' ? to.length >= 3 && to.length <= 16 : to.length >= 3 && to.length <= 50;

            // the account must exist
            if (assert(toValid === true, 'invalid to')) {
              let token = await db.findOne('tokens', { symbol });

              // the symbol must exist
              // then we need to check that the quantity is correct
              if (assert(token !== null, 'symbol does not exist')
                && assert(countDecimals(quantity) <= token.precision, 'symbol precision mismatch')
                && assert(quantity > 0, 'must transfer positive quantity')) {

                if (await subBalance(from, token, quantity, 'contractsBalances')) {
                  await addBalance(to, token, quantity, table);

                  if (res === false) {
                    await addBalance(from, token, quantity, 'contractsBalances');  
                  } else {
                    emit('transferFromContract', { from, to, symbol, quantity });
                  }

                }
              }
            }
          }
        }
      }
    }

    const subBalance = async (account, token, quantity, table) => {
      let balance = await db.findOne(table, { account, 'symbol': token.symbol });
      if (assert(balance !== null, 'balance does not exist') &&
        assert(balance.balance >= quantity, 'overdrawn balance')) {
        const originalBalance = balance.balance;

        balance.balance = calculateBalance(balance.balance, quantity, token.precision, false);

        if (assert(balance.balance < originalBalance, 'cannot subtract')) {
          await db.update(table, balance);

          return true;
        }          
      }

      return false;
    }

    const addBalance = async (account, token, quantity, table) => {
      let balance = await db.findOne(table, { account, 'symbol': token.symbol });
      if (balance === null) {
        balance = {
          account,
          'symbol': token.symbol,
          'balance': quantity
        }
        
        await db.insert(table, balance);

        return true;
      } else {
        const originalBalance = balance.balance;

        balance.balance = calculateBalance(balance.balance, quantity, token.precision, true);
        if (assert(balance.balance > originalBalance, 'cannot add')) {
          await db.update(table, balance);
          return true;
        }

        return false;
      }
    }

    const calculateBalance = function (balance, quantity, precision, add) {
      if (precision === 0) {
        return add ? balance + quantity : balance - quantity
      }

      return add ? BigNumber(balance).plus(quantity).toNumber() : BigNumber(balance).minus(quantity).toNumber()
    }

    const countDecimals = function (value) {
      return BigNumber(value).dp();
    }
    `;

    base64ContractCode = Base64.encode(contractCode);

    contractPayload = {
      name: 'tokens',
      params: '',
      code: base64ContractCode,
    };

    transactions.push(new Transaction(genesisSteemBlock, 0, 'steemsc', 'contract', 'deploy', JSON.stringify(contractPayload)));

    // sscstore contract
    contractCode = `
    actions.createSSC = async (payload) => {
      await db.createTable('params');
      const params = {};
      
      params.priceSBD = 1000000;
      params.priceSteem = 0.001;
      params.quantity = 0.001;
      params.disabled = false;

      await db.insert('params', params);      
    }

    actions.updateParams = async (payload) => {
      if (sender !== owner) return;

      const { priceSBD, priceSteem, quantity, disabled } = payload;

      const params = await db.findOne('params', { });

      params.priceSBD = priceSBD;
      params.priceSteem = priceSteem;
      params.quantity = quantity;
      params.disabled = disabled;

      await db.update('params', params);
    }

    actions.buy = async (payload) => {
      const { recipient, amountSTEEMSBD, isSignedWithActiveKey } = payload;

      if (recipient !== owner) return;

      if (assert(recipient && amountSTEEMSBD && isSignedWithActiveKey, 'invalid params')) {
        const params = await db.findOne('params', { });

        if (params.disabled) return;

        const res = amountSTEEMSBD.split(' ');
  
        const amount = res[0];
        const unit = res[1];
  
        let quantity = 0;
        let quantityToSend = 0;
        BigNumber.set({ DECIMAL_PLACES: 3 });

        // STEEM
        if (unit === 'STEEM') {
          quantity = BigNumber(amount).dividedBy(params.priceSteem);
        } 
        // SBD (disabled)
        else {
          // quantity = BigNumber(amount).dividedBy(params.priceSBD);
        }
  
        BigNumber.set({ DECIMAL_PLACES: 8 });
        quantityToSend = BigNumber(quantity).multipliedBy(params.quantity);
  
        if (quantityToSend > 0) {
          await executeSmartContractAsOwner('tokens', 'transfer', { symbol: "${BP_CONSTANTS.UTILITY_TOKEN_SYMBOL}", quantity: quantityToSend.toNumber(), to: sender })
        }
      }
    }
    `;

    base64ContractCode = Base64.encode(contractCode);

    contractPayload = {
      name: 'sscstore',
      params: '',
      code: base64ContractCode,
    };

    transactions.push(new Transaction(genesisSteemBlock, 0, 'steemsc', 'contract', 'deploy', JSON.stringify(contractPayload)));

    // steem-pegged asset contract
    contractCode = `
    const ACCOUNT_RECEIVING_FEES = 'steemsc';

    actions.createSSC = async (payload) => {
      await db.createTable('withdrawals'); 
    }

    actions.buy = async (payload) => {
      const { recipient, amountSTEEMSBD, isSignedWithActiveKey } = payload;

      if (recipient !== owner) return;

      if (recipient && amountSTEEMSBD && isSignedWithActiveKey) {
        const res = amountSTEEMSBD.split(' ');
  
        const unit = res[1];
  
        // STEEM
        if (assert(unit === 'STEEM', 'only STEEM can be used')) {
          let quantityToSend = Number(res[0]);

          // calculate the 1% fee (with a min of 0.001 STEEM)
          let fee = Number(BigNumber(quantityToSend).multipliedBy(0.01).toFixed(3));

          if (fee < 0.001) {
            fee = 0.001;
          }
  
          quantityToSend = BigNumber(quantityToSend).minus(fee).toNumber();

          if (quantityToSend > 0) {
            await executeSmartContractAsOwner('tokens', 'transfer', { symbol: "STEEMP", quantity: quantityToSend, to: sender })
          }

          if (fee > 0) {
            const memo = 'fee tx ' + transactionId;
            await initiateWithdrawal(transactionId + '-fee', ACCOUNT_RECEIVING_FEES, fee, memo);
          }
        } 
        // SBD
        else {
          // not supported
        }
      }
    }

    actions.withdraw = async (payload) => {
      const { quantity, isSignedWithActiveKey } = payload;

      if (assert(
          quantity && typeof quantity === 'number' && quantity > 0
          && isSignedWithActiveKey, 'invalid params')) {

        // calculate the 1% fee (with a min of 0.001 STEEM)
        let fee = Number(BigNumber(quantity).multipliedBy(0.01).toFixed(3));

        if (fee < 0.001) {
          fee = 0.001;
        }

        const quantityToSend = BigNumber(quantity).minus(fee).toNumber();

        if (quantityToSend > 0) {
          const res = await executeSmartContract('tokens', 'transfer', { symbol: "STEEMP", quantity, to: owner });
  
          if (res.errors === undefined) {
            // withdrawal
            const memo = 'withdrawal tx ' + transactionId;

            await initiateWithdrawal(transactionId, sender, quantityToSend, memo);
          }
        }

        if (fee > 0) {
          const memo = 'fee tx ' + transactionId;
          await initiateWithdrawal(transactionId + '-fee', ACCOUNT_RECEIVING_FEES, fee, memo);
        }
      }
    }

    actions.removeWithdrawal = async (payload) => {
      const { id, isSignedWithActiveKey } = payload;

      if (sender !== owner) return;

      if (id && isSignedWithActiveKey) {
        const withdrawal = await db.findOne('withdrawals', { id });

        if (withdrawal) {
          await db.remove('withdrawals', withdrawal);
        }
      }
    }

    const initiateWithdrawal = async (id, recipient, quantity, memo) => {
        const withdrawal = {};
        
        withdrawal.id = id;
        withdrawal.type = 'STEEM';
        withdrawal.recipient = recipient;
        withdrawal.memo = memo;
        withdrawal.quantity = quantity;

        await db.insert('withdrawals', withdrawal); 
    }
    `;

    base64ContractCode = Base64.encode(contractCode);

    contractPayload = {
      name: 'steempegged',
      params: '',
      code: base64ContractCode,
    };

    transactions.push(new Transaction(genesisSteemBlock, 0, 'steem-peg', 'contract', 'deploy', JSON.stringify(contractPayload)));

    contractCode = `
    const STEEM_PEGGED_SYMBOL = 'STEEMP';
    const CONTRACT_NAME = 'market';

    actions.createSSC = async (payload) => {
      await db.createTable('buyBook', ['symbol', 'account', 'price']);
      await db.createTable('sellBook', ['symbol', 'account', 'price']);
    };
    
    actions.cancel = async (payload) => {
      const { type, id, isSignedWithActiveKey } = payload;

      const types = ['buy', 'sell'];

      if (assert(isSignedWithActiveKey === true, 'you must use a custom_json signed with your active key')
        && assert(type && types.includes(type)
        && id && Number.isInteger(id), 'invalid params')) {
          const table = type === 'buy' ? 'buyBook' : 'sellBook';
          // get order
          const order = await db.findOne(table, { $loki: id });

          if (assert(order, 'order does not exist')
              && order.account === sender) {
              let quantity;
              let symbol;
    
            if (type === 'buy') {
              symbol = order.symbol;
              quantity = order.tokensLocked;
            } else {
              symbol = STEEM_PEGGED_SYMBOL;
              quantity = order.quantity;
            }

            await transferTokens(sender, symbol, quantity, 'user');

            await db.remove(table, order);
          }
      }
    }

    actions.buy = async (payload) => {
      const { symbol, quantity, price, isSignedWithActiveKey } = payload;
      // buy (quantity) STEEM_PEGGED_SYMBOL at (price)(symbol) per STEEM_PEGGED_SYMBOL
      if (assert(isSignedWithActiveKey === true, 'you must use a custom_json signed with your active key')
        && assert(price && typeof price === 'number'
        && symbol && typeof symbol === 'string'
        && quantity && typeof quantity === 'number', 'invalid params')) {

        // get the token params
        const token = await db.findOneInTable('tokens', 'tokens', { symbol });

        // perform a few verifications
        if (token
          && price > 0
          && countDecimals(price) <= token.precision
          && countDecimals(quantity) <= 3) {
          // initiate a transfer from sender to null account
          BigNumber.set({ DECIMAL_PLACES: token.precision });

          const nbTokensToLock = BigNumber(price).multipliedBy(quantity).toNumber();

          const res = await executeSmartContract('tokens', 'transferToContract', { symbol, quantity: nbTokensToLock, to: CONTRACT_NAME });

          if (res.errors === undefined) {
            // order
            const order = {};
            
            order.txId = transactionId;
            order.account = sender;
            order.symbol = symbol;
            order.quantity = quantity;
            order.price = price;
            order.tokensLocked = nbTokensToLock;

            const orderInDB = await db.insert('buyBook', order);

            await findMatchingSellOrders(orderInDB, token.precision);
          }
        }
      }
    };

    actions.sell = async (payload) => {
      const { symbol, quantity, price, isSignedWithActiveKey } = payload;
      // sell (quantity) at (price)(symbol) per STEEM_PEGGED_SYMBOL
      if (assert(isSignedWithActiveKey === true, 'you must use a custom_json signed with your active key')
        && price && typeof price === 'number'
        && symbol && typeof symbol === 'string'
        && quantity && typeof quantity === 'number') {

        // get the token params
        const token = await db.findOneInTable('tokens', 'tokens', { symbol });

        // perform a few verifications
        if (token
          && price > 0
          && countDecimals(price) <= token.precision
          && countDecimals(quantity) <= 3) {
          // initiate a transfer from sender to null account
          const res = await executeSmartContract('tokens', 'transferToContract', { symbol: STEEM_PEGGED_SYMBOL, quantity, to: CONTRACT_NAME });

          if (res.errors === undefined) {
            // order
            const order = {};

            order.txId = transactionId;
            order.account = sender;
            order.symbol = symbol;
            order.quantity = quantity;
            order.price = price;

            const orderInDB = await db.insert('sellBook', order);

            await findMatchingBuyOrders(orderInDB, token.precision);
          }
        }
      }
    };

    const findMatchingSellOrders = async (order, tokenPrecision) => {
      const { txId, account, symbol, quantity, price } = order;
      BigNumber.set({ DECIMAL_PLACES: tokenPrecision });

      const buyOrder = order;
      let offset = 0;
      
      // get the orders that match the symbol and the price
      let sellOrderBook = await db.find('sellBook', {
        symbol,
        price: {
          $lte: price,
        },
      }, 1000, offset,
      [
        { index: 'price', descending: false },
        { index: 'id', descending: false },
      ]);

      do {
        const nbOrders = sellOrderBook.length;
        let inc = 0;
        // debug(sellOrderBook)
        while (inc < nbOrders && buyOrder.quantity > 0) {
          const sellOrder = sellOrderBook[inc];
          if (buyOrder.quantity <= sellOrder.quantity) {

            // transfer the tokens to the accounts
            await transferTokens(account, STEEM_PEGGED_SYMBOL, buyOrder.quantity, 'user');

            const qtyTokensToSend = BigNumber(sellOrder.price).multipliedBy(buyOrder.quantity).toNumber();            
            await transferTokens(sellOrder.account, symbol, qtyTokensToSend, 'user');

            // update the sell order
            const qtyLeftSellOrder = BigNumber(sellOrder.quantity).minus(buyOrder.quantity).toNumber();
            
            if (qtyLeftSellOrder > 0) {
              sellOrder.quantity = qtyLeftSellOrder;

              await db.update('sellBook', sellOrder);
            } else {
              await db.remove('sellBook', sellOrder);
            }

            // unlock remaining tokens, update the quantity to get and remove the buy order
            const tokensToUnlock = BigNumber(buyOrder.tokensLocked).minus(qtyTokensToSend).toNumber();            

            if (tokensToUnlock > 0) {
              await transferTokens(account, symbol, tokensToUnlock, 'user');
            }
            
            buyOrder.quantity = 0;
            await db.remove('buyBook', buyOrder);
          } else {
            // transfer the tokens to the account
            await transferTokens(account, STEEM_PEGGED_SYMBOL, sellOrder.quantity, 'user');
            
            const qtyTokensToSend = BigNumber(sellOrder.price).multipliedBy(sellOrder.quantity).toNumber();
            await transferTokens(sellOrder.account, symbol, qtyTokensToSend, 'user');

            // remove the sell order
            await db.remove('sellBook', sellOrder);

            // update tokensLocked and the quantity to get
            buyOrder.tokensLocked = BigNumber(buyOrder.tokensLocked).minus(qtyTokensToSend).toNumber();
            buyOrder.quantity = BigNumber(buyOrder.quantity).minus(sellOrder.quantity).toNumber();
            

          }

          inc += 1;
        }

        offset += 1000;

        if (buyOrder.quantity > 0) {
          // get the orders that match the symbol and the price
          sellOrderBook = await db.find('sellBook', {
            symbol,
            price: {
              $lte: price,
            },
          }, 1000, offset,
          [
            { index: 'price', descending: false },
            { index: 'id', descending: false },
          ]);
        }
      } while (sellOrderBook.length > 0 && buyOrder.quantity > 0);

      // update the buy order if partially filled
      if (buyOrder.quantity > 0) {
        await db.update('buyBook', buyOrder);
      }
    };

    const findMatchingBuyOrders = async (order, tokenPrecision) => {
      const { txId, account, symbol, quantity, price } = order;
      BigNumber.set({ DECIMAL_PLACES: tokenPrecision });

      const sellOrder = order;
      let offset = 0;

      // get the orders that match the symbol and the price
      let buyOrderBook = await db.find('buyBook', {
        symbol,
        price: {
          $gte: price,
        },
      }, 1000, offset,
      [
        { index: 'price', descending: true },
        { index: 'id', descending: false },
      ]);

      do {
        const nbOrders = buyOrderBook.length;
        let inc = 0;
        //debug(buyOrderBook)
        while (inc < nbOrders && sellOrder.quantity > 0) {
          const buyOrder = buyOrderBook[inc];
          if (sellOrder.quantity <= buyOrder.quantity) {

            // transfer the tokens to the accounts
            await transferTokens(buyOrder.account, STEEM_PEGGED_SYMBOL, sellOrder.quantity, 'user');

            const qtyTokensToSend = BigNumber(buyOrder.price).multipliedBy(sellOrder.quantity).toNumber();
            
            await transferTokens(account, symbol, qtyTokensToSend, 'user');

            // update the buy order
            const qtyLeftBuyOrder = BigNumber(buyOrder.quantity).minus(sellOrder.quantity).toNumber();

            const buyOrdertokensLocked = BigNumber(buyOrder.tokensLocked).minus(qtyTokensToSend).toNumber();
            
            if (qtyLeftBuyOrder > 0) {
              buyOrder.quantity = qtyLeftBuyOrder;
              buyOrder.tokensLocked = buyOrdertokensLocked;

              await db.update('buyBook', buyOrder);
            } else {
              if (buyOrdertokensLocked > 0) {
                await transferTokens(buyOrder.account, symbol, buyOrdertokensLocked, 'user');
              }
              await db.remove('buyBook', buyOrder);
            }
            
            sellOrder.quantity = 0;
            await db.remove('sellBook', sellOrder);
          } else {
            // transfer the tokens to the account
            await transferTokens(buyOrder.account, STEEM_PEGGED_SYMBOL, buyOrder.quantity, 'user');
            
            const qtyTokensToSend = BigNumber(buyOrder.price).multipliedBy(buyOrder.quantity).toNumber();
            await transferTokens(account, symbol, qtyTokensToSend, 'user');

            // remove the buy order
            await db.remove('buyBook', buyOrder);

            // update the quantity to get
            sellOrder.quantity = BigNumber(sellOrder.quantity).minus(buyOrder.quantity).toNumber();
          }

          inc += 1;
        }

        offset += 1000;

        if (sellOrder.quantity > 0) {
          // get the orders that match the symbol and the price
          buyOrderBook = await db.find('buyBook', {
            symbol,
            price: {
              $gte: price,
            },
          }, 1000, offset,
          [
            { index: 'price', descending: true },
            { index: 'id', descending: false },
          ]);
        }
      } while (buyOrderBook.length > 0 && sellOrder.quantity > 0);

      // update the sell order if partially filled
      if (sellOrder.quantity > 0) {
        await db.update('sellBook', sellOrder);
      }
    };

    const countDecimals = function (value) {
      return BigNumber(value).dp();
    };
    `;

    base64ContractCode = Base64.encode(contractCode);

    contractPayload = {
      name: 'market',
      params: '',
      code: base64ContractCode,
    };

    // transactions.push(new Transaction(genesisSteemBlock, 0, 'null', 'contract', 'deploy', JSON.stringify(contractPayload)));


    // bootstrap transactions
    transactions.push(new Transaction(genesisSteemBlock, 0, 'steem-peg', 'tokens', 'create', '{ "name": "STEEM Pegged", "symbol": "STEEMP", "precision": 3, "maxSupply": 1000000000000 }'));
    transactions.push(new Transaction(genesisSteemBlock, 0, 'steemsc', 'tokens', 'updateParams', '{ "tokenCreationFee": 100 }'));
    transactions.push(new Transaction(genesisSteemBlock, 0, 'steem-peg', 'tokens', 'issue', '{ "symbol": "STEEMP", "to": "steem-peg", "quantity": 1000000000000, "isSignedWithActiveKey": true }'));

    return transactions;
  }
}

module.exports.Bootstrap = Bootstrap;
