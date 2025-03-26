import {SavedSwap} from "./SavedSwap";
import {
    BtcStoredHeader,
    ChainEvent,
    ChainSwapType,
    ChainType,
    IStorageManager, SpvVaultClaimEvent, SpvVaultCloseEvent,
    SpvVaultEvent,
    SpvVaultEventType, SpvVaultOpenEvent
} from "@atomiqlabs/base";
import {Watchtower, WatchtowerClaimTxType} from "./Watchtower";


export class SpvVaultSwaps<T extends ChainType, B extends BtcStoredHeader<any>> {

    readonly txinMap: Map<string, T["SpvVaultData"]> = new Map<string, T["SpvVaultData"]>();

    readonly storage: IStorageManager<T["SpvVaultData"]>;
    readonly deserializer: new (data: any) => T["SpvVaultData"];

    readonly spvVaultContract: T["SpvVaultContract"];

    readonly root: Watchtower<T, B>;

    readonly shouldClaimCbk?: (vault: T["SpvVaultData"], swapData: T["SpvVaultWithdrawalData"][]) => Promise<{initAta: boolean, feeRate: any}>;

    constructor(
        root: Watchtower<T, B>,
        storage: IStorageManager<T["SpvVaultData"]>,
        deserializer: new (data: any) => T["SpvVaultData"],
        spvVaultContract: T["SpvVaultContract"],
        shouldClaimCbk?: (vault: T["SpvVaultData"], swapData: T["SpvVaultWithdrawalData"][]) => Promise<{initAta: boolean, feeRate: any}>
    ) {
        this.root = root;
        this.storage = storage;
        this.deserializer = deserializer;
        this.spvVaultContract = spvVaultContract;
        this.shouldClaimCbk = shouldClaimCbk;
    }

    async init() {
        const noVaults = await this.load();

        //Load vaults from chain
        if(noVaults) {
            console.info("SpvVaultSwaps: init(): No vaults founds, syncing vaults from chain...");
            const vaults = await this.spvVaultContract.getAllVaults();
            console.info("SpvVaultSwaps: init(): Vaults synced!");
            for(let vault of vaults) {
                await this.save(vault);
            }
            console.info("SpvVaultSwaps: init(): Vaults saved!");
        }

        this.root.swapEvents.registerListener(async (obj: ChainEvent<T["Data"]>[]) => {
            const saveVaults: Set<string> = new Set<string>();
            for(let event of obj) {
                if(!(event instanceof SpvVaultEvent)) continue;
                if(event instanceof SpvVaultOpenEvent) {
                    //Add vault to the list of tracked vaults
                    const identifier = this.getIdentifier(event.owner, event.vaultId);
                    const existingVault = this.storage.data[identifier];
                    if(existingVault!=null) {
                        console.warn("SpvVaultSwaps: SC Event listener: Vault open event detected, but vault already saved, id: "+identifier);
                        this.txinMap.delete(existingVault.getUtxo());
                    }
                    saveVaults.add(identifier);
                }
                if(event instanceof SpvVaultClaimEvent) {
                    //Advance the state of the vault
                    const identifier = this.getIdentifier(event.owner, event.vaultId);
                    const existingVault = this.storage.data[identifier];
                    if(existingVault!=null) {
                        this.txinMap.delete(existingVault.getUtxo());
                    } else {
                        console.warn("SpvVaultSwaps: SC Event listener: Vault claim event detected, but vault not found, adding now, id: "+identifier);
                    }
                    saveVaults.add(identifier);
                }
                if(event instanceof SpvVaultCloseEvent) {
                    //Remove vault
                    const identifier = this.getIdentifier(event.owner, event.vaultId);
                    const existingVault = this.storage.data[identifier];
                    if(existingVault==null) {
                        console.warn("SpvVaultSwaps: SC Event listener: Vault close event detected, but vault already removed, id: "+identifier);
                    } else {
                        await this.remove(event.owner, event.vaultId);
                    }
                }
            }

            for(let identifier of saveVaults.keys()) {
                const [owner, vaultIdStr] = identifier.split("_");
                await this.save(await this.spvVaultContract.getVaultData(owner, BigInt(vaultIdStr)));
            }
            return true;
        });
    }

    private async load(): Promise<boolean> {
        await this.storage.init();
        const loadedData = await this.storage.loadData(this.deserializer);
        loadedData.forEach(data => {
            this.txinMap.set(data.getUtxo(), data);
        });
        return loadedData.length===0;
    }

    private getIdentifier(owner: string, vaultId: bigint) {
        return owner+"_"+vaultId.toString(10);
    }

    private async save(vault: T["SpvVaultData"]) {
        this.txinMap.set(vault.getUtxo(), vault);
        await this.storage.saveData(vault.getOwner()+"_"+vault.getVaultId().toString(10), vault);
    }

    private async remove(owner: string, vaultId: bigint): Promise<boolean> {
        const identifier = this.getIdentifier(owner, vaultId);
        const vault = this.storage.data[identifier];
        if(vault==null) return false;

        this.txinMap.delete(vault.getUtxo());
        await this.storage.removeData(identifier);

        return true;
    }

    private async tryGetClaimTxs(
        vault: T["SpvVaultData"],
        txs: {txId: string, height: number}[],
        tipHeight: number,
        computedHeaderMap?: {[blockheight: number]: B}
    ): Promise<{
        txs: T["TX"][],
        data: {
            vault: T["SpvVaultData"],
            withdrawals: {
                txId: string,
                maturedAt: number,
                blockheight: number,
                data: T["SpvVaultWithdrawalData"]
            }[]
        }
    }> {
        if(vault.isOpened()) return;

        //Get fresh vault
        vault = await this.spvVaultContract.getVaultData(vault.getOwner(), vault.getVaultId());

        let withdrawals: T["SpvVaultWithdrawalData"][] = [];
        let blockheaders: B[] = [];

        for(let tx of txs) {
            if(tx.height + vault.getConfirmations() - 1 > tipHeight) break;
            try {
                const btcTx = await this.root.bitcoinRpc.getTransaction(tx.txId);
                const parsedTx = await this.spvVaultContract.getWithdrawalData(btcTx);
                const newArr = [...withdrawals, parsedTx];
                vault.calculateStateAfter(newArr);
                withdrawals = newArr;
                blockheaders.push(computedHeaderMap?.[tx.height]);
            } catch (e) {
                console.error("SpvVaultSwaps: tryGetClaimTxs(): Error parsing withdrawal data/calculating state: ", e);
                break;
            }
        }

        let feeRate = undefined;
        let initAta = undefined;
        if(this.shouldClaimCbk!=null) {
            ({feeRate, initAta} = await this.shouldClaimCbk(vault, withdrawals));
        }

        console.info("SpvVaultSwaps: tryGetClaimTxs(): Processing "+withdrawals.length+" withdrawals for vault: "+this.getIdentifier(vault.getOwner(), vault.getVaultId()));

        const resultTxs = await this.spvVaultContract.txsClaim(
            this.root.signer.getAddress(),
            vault,
            withdrawals.map(((tx, index) => {
                return {
                    tx,
                    storedHeader: blockheaders[index]
                }
            })),
            null, initAta, feeRate
        );

        return {
            txs: resultTxs,
            data: {
                vault,
                withdrawals: withdrawals.map((tx, index) => {
                    const btcTx = txs[index];
                    return {
                        txId: btcTx.txId,
                        maturedAt: btcTx.height+vault.getConfirmations()-1,
                        blockheight: btcTx.height,
                        data: tx
                    }
                })
            }
        };
    }

    async getClaimTxs(
        foundTxins?: Map<string, {txId: string, height: number}>,
        computedHeaderMap?: {[blockheight: number]: B}
    ): Promise<{
        [vaultIdentifier: string]: WatchtowerClaimTxType<T>
    }> {
        const tipHeight = this.root.prunedTxoMap.tipHeight;

        const vaultWithdrawalTxs: {
            [vaultIdentifier: string]: {txId: string, height: number}[]
        } = {};

        //Check txoHashes that got required confirmations in the to-be-synchronized blocks,
        // but they might be already pruned if we only checked after
        if(foundTxins!=null) {
            for(let entry of foundTxins.entries()) {
                const utxo = entry[0];
                const vault = this.txinMap.get(utxo);
                const txsData = [entry[1]];

                //Try to also get next withdrawals
                while(true) {
                    const nextUtxo = txsData[txsData.length-1].txId+":0";
                    const nextFoundTxData = foundTxins.get(nextUtxo) || this.root.prunedTxoMap.getTxinObject(nextUtxo);
                    if(nextFoundTxData==null) break;
                    txsData.push(nextFoundTxData);
                }

                vaultWithdrawalTxs[this.getIdentifier(vault.getOwner(), vault.getVaultId())] = txsData;
            }
        }

        //Check all the txs, if they are already confirmed in these blocks
        for(let [utxo, vault] of this.txinMap.entries()) {
            const vaultIdentifier = this.getIdentifier(vault.getOwner(), vault.getVaultId());
            if(vaultWithdrawalTxs[vaultIdentifier]==null) continue;

            const data = this.root.prunedTxoMap.getTxinObject(utxo);
            if(data==null) continue;

            const txsData = [data];
            while(true) {
                const nextUtxo = txsData[txsData.length-1].txId+":0";
                const nextFoundTxData = this.root.prunedTxoMap.getTxinObject(nextUtxo);
                if(nextFoundTxData==null) break;
                txsData.push(nextFoundTxData);
            }

            vaultWithdrawalTxs[vaultIdentifier] = txsData;
        }

        const txs: {
            [vaultIdentifier: string]: WatchtowerClaimTxType<T>
        } = {};

        for(let vaultIdentifier in vaultWithdrawalTxs) {
            const vault = this.storage.data[vaultIdentifier];

            try {
                txs[vaultIdentifier] = await this.tryGetClaimTxs(vault, vaultWithdrawalTxs[vaultIdentifier], tipHeight, computedHeaderMap);
            } catch (e) {
                console.error("SpvVaultSwaps: getClaimTxs(): Error when trying to get claim txs for vault: "+vaultIdentifier, e);
            }
        }

        return txs;
    }

}

