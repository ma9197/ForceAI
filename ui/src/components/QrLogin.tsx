export function QrLogin({ qr }: { qr: string | null }) {
  return (
    <div className="center-screen">
      <h2>Link your WhatsApp</h2>
      {qr ? (
        <img className="qr" src={qr} width={300} height={300} alt="WhatsApp QR code" />
      ) : (
        <p className="muted">Generating QR code…</p>
      )}
      <p className="muted" style={{ maxWidth: 420, textAlign: 'center' }}>
        On your phone: WhatsApp → Settings → Linked Devices → Link a Device, then scan this code.
        The QR refreshes automatically every ~20 seconds.
      </p>
    </div>
  );
}
