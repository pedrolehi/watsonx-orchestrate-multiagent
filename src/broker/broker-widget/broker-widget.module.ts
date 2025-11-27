import { Module } from '@nestjs/common';
import { CoreModule } from '../../core/core.module';
import { BrokerWidgetService } from './broker-widget.service';

@Module({
  imports: [CoreModule],
  providers: [BrokerWidgetService],
  exports: [BrokerWidgetService],
})
export class BrokerWidgetModule {}
