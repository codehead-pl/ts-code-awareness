/** A greeter service used by the core smoke test. */
export class GreeterService {
  private prefix = "Hello";

  /** Greets a name. */
  greet(name: string): string {
    return `${this.prefix}, ${name}`;
  }
}

export interface Repo<T> {
  findById(id: string): Promise<T | null>;
}

export function makeId(): string {
  return Math.random().toString(36).slice(2);
}

export enum Color {
  Red,
  Green,
  Blue,
}

export type Id = string;
