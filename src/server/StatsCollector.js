/**
 * Utility class to collect statistics for one storage.
 */
export default class StorageStatsCollector {

	/**
	 * @param {Storage|ReadableStorage} storage
	 */
	constructor(storage) {
		this.storage = storage;
	}

	/**
	 * Collect statistics about the storage, including the number and size of partitions and indexes, and the total bytes written.
	 * @returns {{
	 * numPartitions: number,
	 * partitions: { [string]: { id: number, size: number, headerSize: number, metadata: object }},
	 * numIndexes,
	 * indexes: { [string]: { size: number, headerSize: number, metadata: object }},
	 * bytesWritten: number
	 * }}
	 */
	stats() {
		const stats = {
			numPartitions: Object.keys(this.storage.partitions).length,
			partitions: {},
			numIndexes: Object.keys(this.storage.secondaryIndexes).length + 1,
			indexes: {},
			bytesWritten: 0
		};
		this.storage.forEachPartition(partition => {
			stats.bytesWritten += partition.size;
			stats.partitions[partition.name] = {
				id: partition.id,
				size: partition.size,
				headerSize: partition.headerSize,
				metadata: partition.metadata
			};
		});
		stats.bytesWritten += this.storage.index.length * this.storage.index.EntryClass.size;
		stats.indexes[this.storage.index.name] = {
			size: this.storage.index.length,
			headerSize: this.storage.index.headerSize,
			metadata: this.storage.index.metadata,
		};
		this.storage.forEachSecondaryIndex(index => {
			stats.bytesWritten += index.length * index.EntryClass.size
			stats.indexes[index.name] = {
				size: index.length,
				headerSize: this.storage.index.headerSize,
				metadata: index.metadata,
			};
		});
		return stats;
	}
}