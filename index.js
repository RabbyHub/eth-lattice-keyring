const crypto = require('crypto');
const EventEmitter = require('events').EventEmitter;
const SDK = require('gridplus-sdk');
const keyringType = 'Lattice Hardware';
const HARDENED_OFFSET = 0x80000000;
const PER_PAGE = 5;

class LatticeKeyring extends EventEmitter {
  constructor (opts={}) {
    super()
    this.type = keyringType
    this._resetDefaults();
    this.deserialize(opts);
  }

  //-------------------------------------------------------------------
  // Keyring API (per `https://github.com/MetaMask/eth-simple-keyring`)
  //-------------------------------------------------------------------
  deserialize (opts = {}) {
    if (opts.creds)
      this.creds = opts.creds;
    if (opts.accounts)
      this.accounts = opts.accounts;
    if (opts.walletUID)
      this.walletUID = opts.walletUID;
    if (opts.name)
      this.name = opts.name;
    if (opts.network)
      this.network = opts.network;
    return Promise.resolve()
  }

  serialize() {
    return Promise.resolve({
      creds: this.creds,
      accounts: this.accounts,
      walletUID: this.walletUID,
      name: this.name,
      network: this.network,
    })
  }

  isUnlocked () {
    return this._hasCreds() && this._hasSession()
  }

  // Initialize a session with the Lattice1 device using the GridPlus SDK
  unlock(updateData=true) {
    return new Promise((resolve, reject) => {
      this._getCreds()
      .then((creds) => {
        if (creds) {
          this.creds.deviceID = creds.deviceID;
          this.creds.password = creds.password;
        }
        return this._initSession();
      })
      .then(() => {
        return this._connect(updateData);
      })
      .then(() => {
        return resolve('Unlocked');
      })
      .catch((err) => {
        return reject(Error(err));
      })
    })
  }

  // Add addresses to the local store and return the full result
  addAccounts(n=1) {
    return new Promise((resolve, reject) => {
      this.unlock()
      .then(() => {
        return this._fetchAddresses(n, this.unlockedAccount)
      })
      .then((addrs) => {
        // Splice the new account(s) into `this.accounts`
        this.accounts.splice(this.unlockedAccount, n);
        this.accounts.splice(this.unlockedAccount, 0, ...addrs);
        return resolve(this.accounts);
      })
      .catch((err) => {
        return reject(err);
      })
    })
  }

  // Return the local store of addresses
  getAccounts() {
    return Promise.resolve(this.accounts ? this.accounts.slice() : [].slice());
  }

  signTransaction (address, tx) {
    return new Promise((resolve, reject) => {
      // NOTE: We are passing `false` here because we do NOT want
      // state data to be updated as a result of a transaction request.
      // It is possible the user inserted or removed a SafeCard and
      // will not be able to sign this transaction. If that is the
      // case, we just want to return an error message
      this.unlock(false)
      .then(() => {
        return this.getAccounts()
      })
      .then((addrs) => {
        // Find the signer in our current set of accounts
        // If we can't find it, return an error
        let addrIdx = null;
        addrs.forEach((addr, i) => {
          if (address.toLowerCase() === addr.toLowerCase())
            addrIdx = i;
        })
        if (addrIdx === null)
          return reject('Signer not present');

        // Build the Lattice request data and make request
        const txData = {
          chainId: tx.getChainId(),
          nonce: Number(`0x${tx.nonce.toString('hex')}`) || 0,
          gasPrice: Number(`0x${tx.gasPrice.toString('hex')}`),
          gasLimit: Number(`0x${tx.gasLimit.toString('hex')}`),
          to: `0x${tx.to.toString('hex')}`,
          value: Number(`0x${tx.value.toString('hex')}`),
          data: tx.data.length === 0 ? null : `0x${tx.data.toString('hex')}`,
          signerPath: [HARDENED_OFFSET+44, HARDENED_OFFSET+60, HARDENED_OFFSET, 0, addrIdx],
        }
        return this._signTxData(txData)
      })
      .then((signedTx) => {
        // Add the sig params. `signedTx = { sig: { v, r, s }, tx, txHash}`
        if (!signedTx.sig || !signedTx.sig.v || !signedTx.sig.r || !signedTx.sig.s)
          return reject(Error('No signature returned'));
        tx.v = signedTx.sig.v;
        tx.r = Buffer.from(signedTx.sig.r, 'hex');
        tx.s = Buffer.from(signedTx.sig.s, 'hex');
        return resolve(tx);
      })
      .catch((err) => {
        return reject(Error(err));
      })
    })
  }

  signMessage(address, data) {
    return Promise.reject(Error('signMessage not yet implemented'))  
  }

  exportAccount(address) {
    return Promise.reject(Error('exportAccount not supported by this device'))
  }

  removeAccount(address) {
    // We only allow one account at a time, so removing any account
    // should result in a state reset. The user will need to reconnect
    // to the Lattice
    this.forgetDevice();
  }

  getFirstPage() {
    this.page = 0;
    return this._getPage(1);
  }

  getNextPage () {
    return this.getFirstPage();
  }

  getPreviousPage () {
    return this.getFirstPage();
  }

  setAccountToUnlock (index) {
    this.unlockedAccount = parseInt(index, 10)
  }

  forgetDevice () {
    this._resetDefaults();
  }

  //-------------------------------------------------------------------
  // Internal methods and interface to SDK
  //-------------------------------------------------------------------
  _resetDefaults() {
    this.accounts = [];
    this.isLocked = true;
    this.creds = {
      deviceID: null,
      password: null,
    };
    this.walletUID = null;
    this.sdkSession = null;
    this.page = 0;
    this.unlockedAccount = 0;
    this.network = null;
  }

  _getCreds() {
    return new Promise((resolve, reject) => {
      // We only need to setup if we don't have a deviceID
      if (this._hasCreds())
        return resolve();

      // If we are not aware of what Lattice we should be talking to,
      // we need to open a window that lets the user go through the
      // pairing or connection process.
      const name = this.name ? this.name : 'Unknown'
      let base = 'https://wallet.gridplus.io';
      if (this.network && this.network !== 'mainnet')
        base = 'https://gridplus-web-wallet-dev.herokuapp.com';
      let url = `${base}?keyring=${name}`;
      if (this.network)
        url += `&network=${this.network}`
      const popup = window.open(url);
      popup.postMessage('GET_LATTICE_CREDS', base);

      // PostMessage handler
      function receiveMessage(event) {
        // Ensure origin
        if (event.origin !== base)
          return;
        // Parse response data
        try {
          const data = JSON.parse(event.data);
          if (!data.deviceID || !data.password)
            return reject(Error('Invalid credentials returned from Lattice.'));
          return resolve(data);
        } catch (err) {
          return reject(err);
        }
      }
      window.addEventListener("message", receiveMessage, false);
    })
  }

  // [re]connect to the Lattice. This should be done frequently to ensure
  // the expected wallet UID is still the one active in the Lattice.
  // This will handle SafeCard insertion/removal events.
  // updateData - true if you want to overwrite walletUID and accounts in
  //              the event that we find we are not synced.
  //              If left false and we notice a new walletUID, we will
  //              return an error.
  _connect(updateData) {
    return new Promise((resolve, reject) => {
      this.sdkSession.connect(this.creds.deviceID, (err) => {
        if (err)
          return reject(err);
        // Save the current wallet UID
        const activeWallet = this.sdkSession.getActiveWallet();
        if (!activeWallet || !activeWallet.uid)
          return reject("No active wallet");
        const newUID = activeWallet.uid.toString('hex');
        // If we fetched a walletUID that does not match our current one,
        // reset accounts and update the known UID
        if (newUID != this.walletUID) {
          // If we don't want to update data, return an error
          if (updateData === false)
            return reject('Wallet has changed! Please reconnect.')
          
          // By default we should clear out accounts and update with
          // the new walletUID. We should NOT fill in the accounts yet,
          // as we reserve that functionality to `addAccounts`
          this.accounts = [];
          this.walletUID = newUID;
        }
        return resolve();
      });
    })
  }

  _initSession() {
    return new Promise((resolve, reject) => {
      if (this._hasSession())
        return resolve();
      try {
        let url = 'https://signing.gridpl.us';
        if (this.network && this.network !== 'mainnet')
          url = 'https://signing.staging-gridpl.us'
        const setupData = {
          name: this.name,
          baseUrl: url,
          crypto,
          timeout: 120000,
          privKey: this._genSessionKey(),
          network: this.network
        }
        this.sdkSession = new SDK.Client(setupData);
        return resolve();
      } catch (err) {
        return reject(err);
      }
    })
  }

  _fetchAddresses(n=1, i=0) {
    return new Promise((resolve, reject) => {
      if (!this._hasSession())
        return reject('No SDK session started. Cannot fetch addresses.')

      // The Lattice does not allow for us to skip indices.
      if (i > this.accounts.length)
        return reject(`Requested address is out of bounds. You may only request index <${this.accounts.length}`)

      // If we have already cached the address(es), we don't need to do it again
      if (this.accounts.length > i)
        return resolve(this.accounts.slice(i, n));
      
      // Make the request to get the requested address
      const addrData = { 
        currency: 'ETH', 
        startPath: [HARDENED_OFFSET+44, HARDENED_OFFSET+60, HARDENED_OFFSET, 0, i], 
        n, // Only request one at a time. This module only supports ETH, so no gap limits
      }
      this.sdkSession.getAddresses(addrData, (err, addrs) => {
        if (err)
          return reject(Error(`Error getting addresses: ${err}`));
        // Sanity check -- if this returned 0 addresses, handle the error
        if (addrs.length < 1)
          return reject('No addresses returned');
        // Return the addresses we fetched *without* updating state
        return resolve(addrs);
      })
    })
  }

  _signTxData(txData) {
    return new Promise((resolve, reject) => {
      if (!this._hasSession())
        return reject('No SDK session started. Cannot sign transaction.')
      this.sdkSession.sign({ currency: 'ETH', data: txData }, (err, res) => {
        if (err)
          return reject(err);
        if (!res.tx)
          return reject('No transaction payload returned.');
        return resolve(res)
      })
    })
  }

  _getPage(increment=1) {
    return new Promise((resolve, reject) => {
      this.page += increment;
      if (this.page <= 0)
        this.page = 1;
      const start = PER_PAGE * (this.page - 1);
      const to = PER_PAGE * this.page;

      this.unlock()
      .then(() => {
        // V1: We will only support export of one (the first) address
        return this._fetchAddresses(1, 0);
        //-----------
      })
      .then((addrs) => {
        // Build some account objects from the addresses
        const localAccounts = [];
        addrs.forEach((addr, i) => {
          localAccounts.push({
            address: addr,
            balance: null,
            index: start + i,
          })
        })
        return resolve(localAccounts);
      })
      .catch((err) => {
        return reject(err);
      })
    })
  }

  _hasCreds() {
    return this.creds.deviceID !== null && this.creds.password !== null && this.name;
  }

  _hasSession() {
    return this.sdkSession && this.walletUID;
  }

  _genSessionKey() {
    if (!this._hasCreds())
      throw new Error('No credentials -- cannot create session key!');
    const buf = Buffer.concat([
      Buffer.from(this.creds.password), 
      Buffer.from(this.creds.deviceID), 
      Buffer.from(this.name)
    ])
    return crypto.createHash('sha256').update(buf).digest();
  }

}

LatticeKeyring.type = keyringType
module.exports = LatticeKeyring;