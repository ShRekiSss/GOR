// Лимитер попыток авторизации: 20/5 мин на IP, хранится в SQLite этого DO.

export class Limiter {
  state: DurableObjectState;

  constructor(state: DurableObjectState) {
    this.state = state;
  }

  private key(now: number): string {
    return `w${Math.floor(now / 300)}`; // окно 5 минут
  }

  async fetch(req: Request): Promise<Response> {
    if (req.method !== 'POST') return new Response('не тот метод', { status: 405 });
    const { limit = 20, window = 300 } = await req.json() as { limit?: number; window?: number };
    const now = Math.floor(Date.now() / 1000);
    const k = `w${Math.floor(now / window)}`;

    const cur = ((await this.state.storage.get<number>(k)) || 0) + 1;
    await this.state.storage.put(k, cur);
    // подчистить прошлые окна
    const past = `w${Math.floor(now / window) - 1}`;
    if (await this.state.storage.get(past)) await this.state.storage.delete(past);
    void limit;

    if (cur > 20) return new Response('превышен лимит', { status: 429 });
    return new Response('ok');
  }
}
