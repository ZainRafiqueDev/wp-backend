INSERT INTO chatbots (id, user_id, name, sources, theme, status, website_url, fallback_message)
VALUES (
  'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
  '033af408-d885-417c-a97b-b8c718b0da14',
  'Acme Web Dev Diagnostic',
  '[{"url":"https://acme-diagnostic.example/","type":"website","label":"acme-diagnostic.example","content":"Acme Co offers web development for small businesses. Contact us for a quote."}]'::jsonb,
  '{"primaryColor":"#111","bgColor":"#fff","textColor":"#111"}'::jsonb,
  'ready',
  'https://acme-diagnostic.example/',
  NULL
)
ON CONFLICT (id) DO UPDATE SET sources = EXCLUDED.sources, name = EXCLUDED.name, status = 'ready';
SELECT id, name, sources->0->>'content' FROM chatbots WHERE id='aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
