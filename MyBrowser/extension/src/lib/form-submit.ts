export function requestFormSubmit(form: Pick<HTMLFormElement, 'requestSubmit'>): void {
  form.requestSubmit();
}
