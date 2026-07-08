export function writeSseEvent(res, event) {
  res.write(`id: ${event.id}\n`);
  res.write(`data: ${JSON.stringify(event.data)}\n\n`);
}
