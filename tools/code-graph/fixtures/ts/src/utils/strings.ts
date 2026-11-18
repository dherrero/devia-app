export function slugify(input: string): string {
  return collapseDashes(input.toLowerCase().replace(/[^a-z0-9]+/g, '-'));
}

export function collapseDashes(input: string): string {
  return input.replace(/-+/g, '-').replace(/^-|-$/g, '');
}

export const capitalise = (input: string): string => input.charAt(0).toUpperCase() + input.slice(1);
