export declare class PrunedSecretsMap {
    maxSize: number;
    buffer: Array<string>;
    nextIndex: number;
    secretsMap: Map<string, string>;
    constructor(maxSize?: number);
    set(escrowHash: string, secret: string): void;
    get(escrowHash: string): string;
}
