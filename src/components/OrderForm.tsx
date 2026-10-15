import type { FC } from 'react';

export interface OrderFormProps {
  onSubmit?: (data: { item: string; quantity: number }) => void;
}

export const OrderForm: FC<OrderFormProps> = ({ onSubmit }) => {
  return (
    <form
      className="order-form"
      onSubmit={e => {
        e.preventDefault();
        onSubmit?.({ item: 'Chorus License', quantity: 1 });
      }}
    >
      <h3>Order Form</h3>
      <input type="text" placeholder="Item name" defaultValue="Chorus License" />
      <input type="number" defaultValue={1} />
      <button type="submit">Submit Order</button>
    </form>
  );
};
