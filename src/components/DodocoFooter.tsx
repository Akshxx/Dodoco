const DodocoFooter = () => (
  <footer className="py-8 px-4 text-center text-xs" style={{ background: 'hsl(var(--footer-bg))', color: 'hsl(var(--muted-foreground))' }}>
    {/* DODOCO logo */}
    <div className="flex justify-center mb-3">
      <span className="text-xl font-heading font-bold tracking-tight" style={{ color: '#ffffff' }}>Dodoco</span>
    </div>
    <p className="mb-1">Real-Time Wildfire & Biodiversity Intelligence Platform</p>
    <p className="mb-3">Built by Dodoco • Data: NASA FIRMS, IUCN, ESA Copernicus</p>
    <div className="flex justify-center gap-4 font-mono">
      <a href="#about" className="hover:text-primary transition-colors">About</a>
      <a href="#faq" className="hover:text-primary transition-colors">FAQ</a>
      <a href="#alerts" className="hover:text-primary transition-colors">Alerts</a>
    </div>
    <p className="mt-4 opacity-60">© 2026 DODOCO. All rights reserved.</p>
  </footer>
);

export default DodocoFooter;
