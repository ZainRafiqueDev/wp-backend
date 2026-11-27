

export const API_BASE_URL = "https://your-booking-api.example.com"

export const CHECK_AVAILABILITY_ACTION = {
  name: "check_appointment_availability",
  description:
    "Look up open appointment slots for a given service and date. Call this before offering the customer a time, and before create_booking.",
  httpMethod: "GET",
  urlTemplate: "/availability?serviceId={{service_id}}&date={{date}}",
  headersTemplate: {},
  bodyTemplate: null,
  parameters: [
    {
      name: "service_id",
      type: "string",
      description: "The service id, e.g. \"consult-30\", \"haircut-45\", or \"deep-clean-60\".",
      required: true,
    },
    {
      name: "date",
      type: "string",
      description: "The date to check, in YYYY-MM-DD format.",
      required: true,
    },
  ],
}

export const CREATE_BOOKING_ACTION = {
  name: "create_booking",
  description:
    "Book a confirmed appointment for the customer. Only call this after confirming an open slot via check_appointment_availability and after collecting the customer's name and email.",
  httpMethod: "POST",
  urlTemplate: "/bookings",
  headersTemplate: {},
  bodyTemplate: {
    serviceId: "{{service_id}}",
    date: "{{date}}",
    time: "{{time}}",
    customerName: "{{customer_name}}",
    customerEmail: "{{customer_email}}",
  },
  parameters: [
    { name: "service_id", type: "string", description: "The service id being booked.", required: true },
    { name: "date", type: "string", description: "The date to book, in YYYY-MM-DD format.", required: true },
    { name: "time", type: "string", description: "The time to book, in HH:MM 24-hour format.", required: true },
    { name: "customer_name", type: "string", description: "The customer's full name.", required: true },
    { name: "customer_email", type: "string", description: "The customer's email address.", required: true },
  ],
}
