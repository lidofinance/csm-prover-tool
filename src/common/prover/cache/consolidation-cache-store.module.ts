import { Module } from '@nestjs/common';

import { PersistentConsolidationCacheStore } from './consolidation-cache-store';

@Module({
  providers: [PersistentConsolidationCacheStore],
  exports: [PersistentConsolidationCacheStore],
})
export class ConsolidationCacheStoreModule {}
