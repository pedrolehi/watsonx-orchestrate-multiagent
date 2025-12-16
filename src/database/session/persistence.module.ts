import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { Session, SessionSchema } from '../entities/session.entity';
import { Message, MessageSchema } from '../entities/message.entity';
import { PersistenceService } from './persistence.service';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: Session.name, schema: SessionSchema },
      { name: Message.name, schema: MessageSchema },
    ]),
  ],
  providers: [PersistenceService],
  exports: [PersistenceService],
})
export class PersistenceModule {}
