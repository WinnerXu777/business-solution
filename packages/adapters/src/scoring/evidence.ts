import { loadDemoFixtures, type Customer } from '@bs/contracts';

const { orders } = loadDemoFixtures();

export function supportingOrders(customer: Customer): string[] {
  return orders
    .filter(
      (order) =>
        order.tenantId === customer.tenantId &&
        order.customerId === customer.id &&
        order.status === 'fulfilled' &&
        order.placedOn === customer.lastOrderOn,
    )
    .map((order) => order.id);
}
