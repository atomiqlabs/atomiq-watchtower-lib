"use strict";
var __awaiter = (this && this.__awaiter) || function (thisArg, _arguments, P, generator) {
    function adopt(value) { return value instanceof P ? value : new P(function (resolve) { resolve(value); }); }
    return new (P || (P = Promise))(function (resolve, reject) {
        function fulfilled(value) { try { step(generator.next(value)); } catch (e) { reject(e); } }
        function rejected(value) { try { step(generator["throw"](value)); } catch (e) { reject(e); } }
        function step(result) { result.done ? resolve(result.value) : adopt(result.value).then(fulfilled, rejected); }
        step((generator = generator.apply(thisArg, _arguments || [])).next());
    });
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.SpvVaultSwaps = void 0;
const base_1 = require("@atomiqlabs/base");
class SpvVaultSwaps {
    constructor(root, storage, deserializer, spvVaultContract, shouldClaimCbk) {
        this.txinMap = new Map();
        this.root = root;
        this.storage = storage;
        this.deserializer = deserializer;
        this.spvVaultContract = spvVaultContract;
        this.shouldClaimCbk = shouldClaimCbk;
    }
    init() {
        return __awaiter(this, void 0, void 0, function* () {
            const noVaults = yield this.load();
            //Load vaults from chain
            if (noVaults) {
                console.info("SpvVaultSwaps: init(): No vaults founds, syncing vaults from chain...");
                const vaults = yield this.spvVaultContract.getAllVaults();
                console.info("SpvVaultSwaps: init(): Vaults synced!");
                for (let vault of vaults) {
                    yield this.save(vault);
                }
                console.info("SpvVaultSwaps: init(): Vaults saved!");
            }
            this.root.swapEvents.registerListener((obj) => __awaiter(this, void 0, void 0, function* () {
                const saveVaults = new Set();
                for (let event of obj) {
                    if (!(event instanceof base_1.SpvVaultEvent))
                        continue;
                    if (event instanceof base_1.SpvVaultOpenEvent) {
                        //Add vault to the list of tracked vaults
                        const identifier = this.getIdentifier(event.owner, event.vaultId);
                        const existingVault = this.storage.data[identifier];
                        if (existingVault != null) {
                            console.warn("SpvVaultSwaps: SC Event listener: Vault open event detected, but vault already saved, id: " + identifier);
                            this.txinMap.delete(existingVault.getUtxo());
                        }
                        saveVaults.add(identifier);
                    }
                    if (event instanceof base_1.SpvVaultClaimEvent) {
                        //Advance the state of the vault
                        const identifier = this.getIdentifier(event.owner, event.vaultId);
                        const existingVault = this.storage.data[identifier];
                        if (existingVault != null) {
                            this.txinMap.delete(existingVault.getUtxo());
                        }
                        else {
                            console.warn("SpvVaultSwaps: SC Event listener: Vault claim event detected, but vault not found, adding now, id: " + identifier);
                        }
                        saveVaults.add(identifier);
                    }
                    if (event instanceof base_1.SpvVaultCloseEvent) {
                        //Remove vault
                        const identifier = this.getIdentifier(event.owner, event.vaultId);
                        const existingVault = this.storage.data[identifier];
                        if (existingVault == null) {
                            console.warn("SpvVaultSwaps: SC Event listener: Vault close event detected, but vault already removed, id: " + identifier);
                        }
                        else {
                            yield this.remove(event.owner, event.vaultId);
                        }
                    }
                }
                for (let identifier of saveVaults.keys()) {
                    const [owner, vaultIdStr] = identifier.split("_");
                    yield this.save(yield this.spvVaultContract.getVaultData(owner, BigInt(vaultIdStr)));
                }
                return true;
            }));
        });
    }
    load() {
        return __awaiter(this, void 0, void 0, function* () {
            yield this.storage.init();
            const loadedData = yield this.storage.loadData(this.deserializer);
            loadedData.forEach(data => {
                this.txinMap.set(data.getUtxo(), data);
            });
            return loadedData.length === 0;
        });
    }
    getIdentifier(owner, vaultId) {
        return owner + "_" + vaultId.toString(10);
    }
    save(vault) {
        return __awaiter(this, void 0, void 0, function* () {
            this.txinMap.set(vault.getUtxo(), vault);
            yield this.storage.saveData(vault.getOwner() + "_" + vault.getVaultId().toString(10), vault);
        });
    }
    remove(owner, vaultId) {
        return __awaiter(this, void 0, void 0, function* () {
            const identifier = this.getIdentifier(owner, vaultId);
            const vault = this.storage.data[identifier];
            if (vault == null)
                return false;
            this.txinMap.delete(vault.getUtxo());
            yield this.storage.removeData(identifier);
            return true;
        });
    }
    tryGetClaimTxs(vault, txs, tipHeight, computedHeaderMap) {
        return __awaiter(this, void 0, void 0, function* () {
            if (!vault.isOpened()) {
                console.log("SpvVaultSwaps: tryGetClaimTxs(): Tried to claim but vault is not opened!");
                return null;
            }
            //Get fresh vault
            vault = yield this.spvVaultContract.getVaultData(vault.getOwner(), vault.getVaultId());
            let withdrawals = [];
            let blockheaders = [];
            for (let tx of txs) {
                if (tx.height + vault.getConfirmations() - 1 > tipHeight)
                    break;
                console.log("SpvVaultSwaps: tryGetClaimTxs(): Adding new tx to withdrawals, owner: " + vault.getOwner() + " vaultId: " + vault.getVaultId().toString(10) + " btcTx: ", tx);
                try {
                    const btcTx = yield this.root.bitcoinRpc.getTransaction(tx.txId);
                    const parsedTx = yield this.spvVaultContract.getWithdrawalData(btcTx);
                    const newArr = [...withdrawals, parsedTx];
                    vault.calculateStateAfter(newArr);
                    withdrawals = newArr;
                    blockheaders.push(computedHeaderMap === null || computedHeaderMap === void 0 ? void 0 : computedHeaderMap[tx.height]);
                }
                catch (e) {
                    console.error("SpvVaultSwaps: tryGetClaimTxs(): Error parsing withdrawal data/calculating state: ", e);
                    break;
                }
            }
            if (withdrawals.length === 0)
                return null;
            let feeRate = undefined;
            let initAta = undefined;
            if (this.shouldClaimCbk != null) {
                const result = yield this.shouldClaimCbk(vault, withdrawals);
                if (result == null) {
                    console.log("SpvVaultSwaps: tryGetClaimTxs(): Not claiming due to negative response from claim cbk, owner: " + vault.getOwner() + " vaultId: " + vault.getVaultId().toString(10) + " withdrawals: " + withdrawals.length);
                    return null;
                }
                ({ feeRate, initAta } = result);
            }
            console.info("SpvVaultSwaps: tryGetClaimTxs(): Processing " + withdrawals.length + " withdrawals for vault: " + this.getIdentifier(vault.getOwner(), vault.getVaultId()));
            const withdrawalTxData = withdrawals.map(((tx, index) => {
                return {
                    tx,
                    storedHeader: blockheaders[index],
                    height: txs[index].height
                };
            }));
            return {
                getTxs: (height, checkClaimable) => __awaiter(this, void 0, void 0, function* () {
                    let useWithdrawalTxData = withdrawalTxData;
                    let useVault = vault;
                    if (height != null) {
                        //Filter out the withdrawals that haven't matured yet
                        useWithdrawalTxData = useWithdrawalTxData.filter(val => val.height + useVault.getConfirmations() - 1 <= height);
                    }
                    if (checkClaimable) {
                        //Get fresh vault
                        useVault = yield this.spvVaultContract.getVaultData(vault.getOwner(), vault.getVaultId());
                        if (useVault.getUtxo() !== vault.getUtxo()) {
                            //Only process withdrawal tx data up from the new vault utxo
                            const startIndex = useWithdrawalTxData.findIndex(val => val.tx.getSpentVaultUtxo() === useVault.getUtxo());
                            if (startIndex == -1)
                                return null;
                            useWithdrawalTxData = useWithdrawalTxData.slice(startIndex);
                        }
                    }
                    if (useWithdrawalTxData.length === 0)
                        return null;
                    return yield this.spvVaultContract.txsClaim(this.root.signer.getAddress(), vault, withdrawalTxData, null, initAta, feeRate);
                }),
                data: {
                    vault,
                    withdrawals: withdrawals.map((tx, index) => {
                        const btcTx = txs[index];
                        return {
                            txId: btcTx.txId,
                            maturedAt: btcTx.height + vault.getConfirmations() - 1,
                            blockheight: btcTx.height,
                            data: tx
                        };
                    })
                }
            };
        });
    }
    getClaimTxs(foundTxins, computedHeaderMap) {
        return __awaiter(this, void 0, void 0, function* () {
            const tipHeight = this.root.prunedTxoMap.tipHeight;
            const vaultWithdrawalTxs = {};
            //Check txoHashes that got required confirmations in the to-be-synchronized blocks,
            // but they might be already pruned if we only checked after
            const processedUtxos = new Set();
            if (foundTxins != null) {
                console.log("SpvVaultSwaps: getClaimTxs(): Checking found txins: ", foundTxins);
                for (let entry of foundTxins.entries()) {
                    const utxo = entry[0];
                    if (processedUtxos.has(utxo)) {
                        console.log("SpvVaultSwaps: getClaimTxs(): Skipping utxo, already processed, utxo: ", processedUtxos);
                        continue;
                    }
                    const vault = this.txinMap.get(utxo);
                    if (vault == null) {
                        console.warn("SpvVaultSwaps: getClaimTxs(): Skipping claiming of tx " + entry[1].txId + " because swap vault isn't known!");
                        continue;
                    }
                    const txsData = [entry[1]];
                    console.log("SpvVaultSwaps: getClaimTxs(): Adding initial btc tx owner: " + vault.getOwner() + " vaultId: " + vault.getVaultId().toString(10) + " btcTx: ", entry[1]);
                    //Try to also get next withdrawals
                    while (true) {
                        const nextUtxo = txsData[txsData.length - 1].txId + ":0";
                        const nextFoundTxData = foundTxins.get(nextUtxo) || this.root.prunedTxoMap.getTxinObject(nextUtxo);
                        if (nextFoundTxData == null)
                            break;
                        processedUtxos.add(nextUtxo);
                        txsData.push(nextFoundTxData);
                        console.log("SpvVaultSwaps: getClaimTxs(): Adding additional btc tx owner: " + vault.getOwner() + " vaultId: " + vault.getVaultId().toString(10) + " btcTx: ", nextFoundTxData);
                    }
                    vaultWithdrawalTxs[this.getIdentifier(vault.getOwner(), vault.getVaultId())] = txsData;
                }
            }
            //Check all the txs, if they are already confirmed in these blocks
            for (let [utxo, vault] of this.txinMap.entries()) {
                if (processedUtxos.has(utxo)) {
                    console.log("SpvVaultSwaps: getClaimTxs(): Skipping utxo, already processed, utxo: ", processedUtxos);
                    continue;
                }
                const vaultIdentifier = this.getIdentifier(vault.getOwner(), vault.getVaultId());
                if (vaultWithdrawalTxs[vaultIdentifier] != null) {
                    console.log("SpvVaultSwaps: getClaimTxs(): Skipping vault, already processed, owner: " + vault.getOwner() + " vaultId: " + vault.getVaultId().toString(10));
                    continue;
                }
                const data = this.root.prunedTxoMap.getTxinObject(utxo);
                if (data == null)
                    continue;
                const txsData = [data];
                console.log("SpvVaultSwaps: getClaimTxs(): Adding initial btc tx owner: " + vault.getOwner() + " vaultId: " + vault.getVaultId().toString(10) + " btcTx: ", data);
                while (true) {
                    const nextUtxo = txsData[txsData.length - 1].txId + ":0";
                    const nextFoundTxData = this.root.prunedTxoMap.getTxinObject(nextUtxo);
                    if (nextFoundTxData == null)
                        break;
                    txsData.push(nextFoundTxData);
                    console.log("SpvVaultSwaps: getClaimTxs(): Adding additional btc tx owner: " + vault.getOwner() + " vaultId: " + vault.getVaultId().toString(10) + " btcTx: ", nextFoundTxData);
                }
                vaultWithdrawalTxs[vaultIdentifier] = txsData;
            }
            const txs = {};
            for (let vaultIdentifier in vaultWithdrawalTxs) {
                const vault = this.storage.data[vaultIdentifier];
                try {
                    const res = yield this.tryGetClaimTxs(vault, vaultWithdrawalTxs[vaultIdentifier], tipHeight, computedHeaderMap);
                    if (res == null)
                        continue;
                    txs[vaultIdentifier] = res;
                }
                catch (e) {
                    console.error("SpvVaultSwaps: getClaimTxs(): Error when trying to get claim txs for vault: " + vaultIdentifier, e);
                }
            }
            return txs;
        });
    }
}
exports.SpvVaultSwaps = SpvVaultSwaps;
