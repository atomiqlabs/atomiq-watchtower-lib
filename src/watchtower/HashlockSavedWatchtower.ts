import {
    ChainEvent,
    ChainSwapType,
    ChainType, InitializeEvent,
    IStorageManager,
    Message,
    MessageType,
    Messenger,
    SwapClaimWitnessMessage,
    SwapData, SwapEvent
} from "@atomiqlabs/base";
import {getLogger} from "../utils/Utils";
import {SavedSwap} from "./SavedSwap";
import {PrunedSecretsMap} from "../utils/PrunedSecretsMap";
import {createHash} from "crypto";


const logger = getLogger("HashlockWatchtower: ");

export class HashlockSavedWatchtower<T extends ChainType> {

    readonly storage: IStorageManager<SavedSwap<T>>;

    readonly swapEvents: T["Events"];
    readonly signer: T["Signer"];
    readonly swapContract: T["Contract"];
    readonly swapDataType: { new(): T["Data"] };
    readonly shouldClaimCbk?: (swap: SavedSwap<T>) => Promise<{initAta: boolean, feeRate: any}>;
    readonly messenger: Messenger;

    readonly escrowHashMap: Map<string, SavedSwap<T>> = new Map<string, SavedSwap<T>>();
    readonly secretsMap: PrunedSecretsMap = new PrunedSecretsMap();

    constructor(
        storage: IStorageManager<SavedSwap<T>>,
        messenger: Messenger,
        chainEvents: T["Events"],
        swapContract: T["Contract"],
        swapDataType: { new(): T["Data"] },
        signer: T["Signer"],
        escrowShouldClaimCbk?: (swap: SavedSwap<T>) => Promise<{initAta: boolean, feeRate: any}>
    ) {
        this.storage = storage;
        this.swapEvents = chainEvents;
        this.swapContract = swapContract;
        this.signer = signer;
        this.swapDataType = swapDataType;
        this.signer = signer;
        this.messenger = messenger;
        this.shouldClaimCbk = escrowShouldClaimCbk;

        this.swapEvents.registerListener(async (obj: ChainEvent<T["Data"]>[]) => {
            for(let event of obj) {
                if(!(event instanceof SwapEvent)) continue;
                if(event instanceof InitializeEvent) {
                    if(event.swapType!==ChainSwapType.HTLC) continue;

                    const swapData: SwapData = await event.swapData();
                    if(swapData.hasSuccessAction()) continue;

                    const savedSwap: SavedSwap<T> = SavedSwap.fromSwapData(swapData);

                    logger.info("chainsEventListener: Adding new swap to watchlist: ", savedSwap);

                    await this.save(savedSwap);

                    const escrowHash = swapData.getEscrowHash()
                    const witness = this.secretsMap.get(escrowHash);
                    if(witness==null) continue;

                    if(this.claimsInProcess[escrowHash]!=null) {
                        logger.debug("chainsEventListener: Skipping escrowHash: "+escrowHash+" due to already being processed!");
                        continue;
                    }
                    this.claimsInProcess[escrowHash] = this.claim(swapData as T["Data"], witness).then(() => {
                        delete this.claimsInProcess[escrowHash];
                        logger.debug("chainsEventListener: Removing swap escrowHash: "+escrowHash+" due to claim being successful!");
                        this.remove(escrowHash);
                    }, (e) => {
                        logger.error("chainsEventListener: Error when claiming swap escrowHash: "+escrowHash, e);
                        delete this.claimsInProcess[escrowHash];
                    });
                } else {
                    const success = await this.remove(event.escrowHash);
                    if(success) {
                        logger.info("chainsEventListener: Removed swap from watchlist: ", event.escrowHash);
                    }
                }
            }
            return true;
        });
    }

    private async load() {
        await this.storage.init();
        const loadedData = await this.storage.loadData(SavedSwap);
        loadedData.forEach(swap => {
            this.escrowHashMap.set(swap.swapData.getEscrowHash(), swap);
        });
    }

    private async save(swap: SavedSwap<T>) {
        const escrowHash = swap.swapData.getEscrowHash();
        this.escrowHashMap.set(escrowHash, swap);
        await this.storage.saveData(escrowHash, swap);
    }

    private async remove(escrowHash: string): Promise<boolean> {
        if(!this.escrowHashMap.delete(escrowHash)) return false;
        await this.storage.removeData(escrowHash);
        return true;
    }

    async claim(swapData: T["Data"], witness: string): Promise<void> {
        const isCommitted = await this.swapContract.isCommited(swapData);
        if(!isCommitted) return;
        if(this.shouldClaimCbk!=null) {
            const feeData = await this.shouldClaimCbk(SavedSwap.fromSwapData(swapData));
            if(feeData==null) {
                logger.debug("claim(): Not claiming swap with escrowHash: "+swapData.getEscrowHash()+" due to negative response from shouldClaimCbk() callback!");
                return;
            }
            await this.swapContract.claimWithSecret(this.signer, swapData, witness, false, feeData.initAta, {feeRate: feeData.feeRate, waitForConfirmation: true});
        } else {
            await this.swapContract.claimWithSecret(this.signer, swapData, witness, false, undefined, {waitForConfirmation: true});
        }
        logger.info("claim(): Claimed successfully escrowHash: "+swapData.getEscrowHash()+" with witness: "+witness+"!");
    }

    readonly claimsInProcess: {[escrowHash: string]: Promise<void>} = {};

    async init(): Promise<void> {
        await this.load();
        logger.info("init(): Initialized!");
    }

    async subscribeToMessages() {
        await this.messenger.init();
        await this.messenger.subscribe((_msg: Message) => {
            if(_msg.type !== MessageType.SWAP_CLAIM_WITNESS) return;
            const msg = _msg as SwapClaimWitnessMessage<SwapData>;
            if(!(msg.swapData instanceof this.swapDataType)) return;
            if(msg.swapData.getType()!==ChainSwapType.HTLC) return;
            try {
                const parsedWitness = Buffer.from(msg.witness, "hex");
                if(parsedWitness.length!==32) return;
                const paymentHash = createHash("sha256").update(parsedWitness).digest();
                const expectedClaimHash = this.swapContract.getHashForHtlc(paymentHash);
                if(msg.swapData.getClaimHash()!==expectedClaimHash.toString("hex")) return;
            } catch (e) {
                return;
            }
            const escrowHash = msg.swapData.getEscrowHash();
            if(this.secretsMap.set(escrowHash, msg.witness)) logger.debug("messageListener: Added new known secret: "+msg.witness+" escrowHash: "+escrowHash);
            if(!this.escrowHashMap.has(escrowHash)) {
                logger.debug("messageListener: Skipping escrowHash: "+escrowHash+" due to swap not being initiated!");
                return;
            }
            if(this.claimsInProcess[escrowHash]!=null) {
                logger.debug("messageListener: Skipping escrowHash: "+escrowHash+" due to already being processed!");
                return;
            }
            logger.info("messageListener: Attempting to claim escrowHash: "+escrowHash+" with secret: "+msg.witness+"!");
            this.claimsInProcess[escrowHash] = this.claim(msg.swapData as T["Data"], msg.witness).then(() => {
                delete this.claimsInProcess[escrowHash];
                logger.debug("messageListener: Removing swap escrowHash: "+escrowHash+" due to claim being successful!");
                this.remove(escrowHash);
            }, (e) => {
                logger.error("messageListener: Error when claiming swap escrowHash: "+escrowHash);
                delete this.claimsInProcess[escrowHash];
            });
        });
        logger.info("subscribeToMessages(): Subscribed to messages!");
    }

}
