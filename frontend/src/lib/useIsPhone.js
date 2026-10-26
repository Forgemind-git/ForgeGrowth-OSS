// One definition of "phone" for the whole app, so the shell, the CSS media
// queries and any page that lays itself out differently all switch together.
// "Phone" here means phones AND portrait tablets: at 900px or less the side
// nav and multi-pane pages do not fit, so both get the compact layout.
// Keep PHONE_MAX in step with the `@media (max-width: 900px)` rules in
// index.css and styles/forge.css.
import { useEffect, useState } from 'react';

export const PHONE_MAX = 900;
export const PHONE_QUERY = `(max-width: ${PHONE_MAX}px)`;

export function isPhoneNow() {
  return typeof window !== 'undefined' && !!window.matchMedia && window.matchMedia(PHONE_QUERY).matches;
}

export function useIsPhone() {
  const [phone, setPhone] = useState(isPhoneNow);
  useEffect(() => {
    if (!window.matchMedia) return undefined;
    const mq = window.matchMedia(PHONE_QUERY);
    const on = () => setPhone(mq.matches);
    on();
    mq.addEventListener('change', on);
    return () => mq.removeEventListener('change', on);
  }, []);
  return phone;
}
