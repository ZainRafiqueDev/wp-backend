

export interface WooCommerceProduct {
  id: number
  name: string
  description: string
  price: string
  regular_price: string
  stock_quantity: number | null
  stock_status: "instock" | "outofstock" | "onbackorder"
  manage_stock: boolean
  permalink: string
  images: { src: string }[]
}

export interface WooCommerceLineItem {
  product_id: number
  quantity: number
  name?: string
  price?: string
  subtotal?: string
  total?: string
}

export interface WooCommerceOrder {
  id: number
  number: string
  order_key: string
  status: string
  currency: string
  total: string
  date_paid: string | null
  payment_method: string
  payment_method_title: string
  line_items: WooCommerceLineItem[]
  billing?: {
    first_name?: string
    last_name?: string
    email?: string
    phone?: string
  }
}

export interface CreateOrderInput {
  lineItems: { productId: number; quantity: number }[]
  customer: { firstName: string; lastName: string; email: string; phone?: string | null }
}
