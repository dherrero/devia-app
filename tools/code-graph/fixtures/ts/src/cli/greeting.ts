import { capitalise } from '../utils/strings';

export default function greeting(name: string): string {
  return `Hello ${capitalise(name)}`;
}
