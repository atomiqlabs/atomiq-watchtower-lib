import { StorageObject, IStorageManager } from "@atomiqlabs/base";
export declare class StorageManager<T extends StorageObject> implements IStorageManager<T> {
    private readonly directory;
    data: {
        [key: string]: T;
    };
    constructor(directory: string);
    init(): Promise<void>;
    saveData(hash: string, object: T): Promise<void>;
    removeData(hash: string): Promise<void>;
    loadData(type: new (data: any) => T): Promise<T[]>;
}
