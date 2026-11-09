// The ChatX logo (a transparent cut-out, see public/logo.webp). `big` is for the login page, otherwise it is the small
// header version.
export default function Logo({ big = false }) {
  return (
    <img
      className={`logo-img ${big ? 'big' : ''}`}
      src={big ? '/logo.webp' : '/logo-sm.webp'}
      alt="ChatX"
      width={big ? 900 : 480}
      height={big ? 441 : 235}
      draggable="false"
    />
  );
}
