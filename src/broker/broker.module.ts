import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { BrokerWidgetModule } from './broker-widget/broker-widget.module';
import { BrokerController } from './broker.controller';

@Module({
  imports: [BrokerWidgetModule, AuthModule],
  controllers: [BrokerController],
})
export class BrokerModule {}
