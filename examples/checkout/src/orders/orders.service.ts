import { Injectable, NotFoundException } from '@nestjs/common';
import type { CreateOrderDto } from './dto/create-order.dto';
import { OrderResponseDto } from './dto/order-response.dto';
import { OrdersRepository } from './orders.repository';

@Injectable()
export class OrdersService {
  constructor(private readonly repository: OrdersRepository) {}

  async create(input: CreateOrderDto): Promise<OrderResponseDto> {
    return new OrderResponseDto(await this.repository.create(input));
  }

  async findById(id: string): Promise<OrderResponseDto> {
    const order = await this.repository.findById(id);
    if (!order) {
      throw new NotFoundException('Order not found.');
    }
    return new OrderResponseDto(order);
  }
}
