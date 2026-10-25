import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
  UsePipes,
} from '@nestjs/common';
import { CreateOrderDto } from './dto/create-order.dto';
import { OrderResponseDto } from './dto/order-response.dto';
import { OrdersService } from './orders.service';
import { OrdersValidationPipe } from './orders-validation.pipe';
import { PayOrderBodyPipe } from './pay-order-body.pipe';

@Controller('orders')
export class OrdersController {
  constructor(private readonly orders: OrdersService) {}

  @Post()
  @UsePipes(new OrdersValidationPipe())
  create(@Body() input: CreateOrderDto): Promise<OrderResponseDto> {
    return this.orders.create(input);
  }

  @Get(':id')
  findById(
    @Param('id', new ParseUUIDPipe()) id: string,
  ): Promise<OrderResponseDto> {
    return this.orders.findById(id);
  }

  @Post(':id/pay')
  @HttpCode(200)
  pay(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body(new PayOrderBodyPipe()) _body: unknown,
  ): Promise<OrderResponseDto> {
    void _body;
    return this.orders.pay(id);
  }
}
