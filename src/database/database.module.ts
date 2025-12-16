import { Module } from '@nestjs/common';
import { MongodbModule } from './mongodb/mongodb.module';
import { PersistenceModule } from './session/persistence.module';

@Module({
  imports: [MongodbModule, PersistenceModule],
  exports: [PersistenceModule],
})
export class DatabaseModule {}
