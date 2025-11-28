import { Module } from '@nestjs/common';
import { AuthModule } from '../../auth/auth.module';
import { CoreModule } from '../../core/core.module';
import { BrokerWidgetService } from './broker-widget.service';

@Module({
  imports: [CoreModule, AuthModule],
  providers: [BrokerWidgetService],
  exports: [BrokerWidgetService],
})
export class BrokerWidgetModule {}
