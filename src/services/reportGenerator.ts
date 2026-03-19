import React from 'react';
import { createRoot } from 'react-dom/client';
import type { FireEvent, Species } from '@/services/apiTypes';
import type { ReportWeather } from '@/components/DodocoFireReport';

/**
 * Dynamically imports heavy PDF libraries and renders the report
 * to a PDF download — all client-side, no server needed.
 */
export async function generateAndDownloadPDF(
  fire: FireEvent,
  species: Species[],
  weather: ReportWeather,
  aiSummary: string
): Promise<void> {
  // Lazy-load heavy deps (only when user actually requests a report)
  const [{ default: html2canvas }, { default: jsPDF }, { default: DodocoFireReport }] = await Promise.all([
    import('html2canvas'),
    import('jspdf'),
    import('@/components/DodocoFireReport'),
  ]);

  // Build the enriched fire object with Gemini AI summary
  const enrichedFire: FireEvent = { ...fire, aiSummary };

  // Create an off-screen container sized for the report (A4-ish width)
  const container = document.createElement('div');
  container.style.cssText = [
    'position: fixed',
    'left: -12000px',
    'top: 0',
    'width: 1100px',
    'overflow: visible',
    'z-index: -9999',
    'background: #f4f6f9',
  ].join(';');
  document.body.appendChild(container);

  const root = createRoot(container);

  try {
    // Render report component into off-screen container
    await new Promise<void>(resolve => {
      root.render(
        React.createElement(DodocoFireReport, {
          fire: enrichedFire,
          species,
          weather,
        })
      );
      // Allow React to paint + Google Fonts to load
      setTimeout(resolve, 1800);
    });

    // Wait for all fonts
    await document.fonts.ready;

    const reportEl = container.firstElementChild as HTMLElement;
    if (!reportEl) throw new Error('Report element not found');

    // Capture the entire report as a canvas
    const canvas = await html2canvas(reportEl, {
      scale: 1.8,
      useCORS: true,
      allowTaint: true,
      logging: false,
      backgroundColor: '#f4f6f9',
      windowWidth: 1100,
      scrollX: 0,
      scrollY: 0,
    });

    // A4 dimensions in mm
    const A4_W = 210;
    const A4_H = 297;
    const marginMm = 0;

    const canvasWidthMm = A4_W - marginMm * 2;
    const canvasHeightMm = (canvas.height / canvas.width) * canvasWidthMm;

    const pdf = new (jsPDF as any)({
      orientation: 'portrait',
      unit: 'mm',
      format: 'a4',
      compress: true,
    });

    const imgData = canvas.toDataURL('image/jpeg', 0.92);

    let yOffset = marginMm;
    let remainingHeight = canvasHeightMm;

    const printablePageHeight = A4_H - marginMm * 2;

    while (remainingHeight > 0) {
      const sliceHeightMm = Math.min(remainingHeight, printablePageHeight);
      const sliceHeightPx = (sliceHeightMm / canvasHeightMm) * canvas.height;
      const yOffsetPx = ((canvasHeightMm - remainingHeight) / canvasHeightMm) * canvas.height;

      // Create a slice canvas for this page
      const sliceCanvas = document.createElement('canvas');
      sliceCanvas.width = canvas.width;
      sliceCanvas.height = sliceHeightPx;
      const ctx = sliceCanvas.getContext('2d')!;
      ctx.drawImage(canvas, 0, -yOffsetPx);

      const sliceData = sliceCanvas.toDataURL('image/jpeg', 0.92);
      pdf.addImage(sliceData, 'JPEG', marginMm, yOffset, canvasWidthMm, sliceHeightMm);

      remainingHeight -= printablePageHeight;
      if (remainingHeight > 0) {
        pdf.addPage();
        yOffset = marginMm;
      }
    }

    const safeId = fire.id.replace(/[^a-z0-9]/gi, '-').toLowerCase();
    const timestamp = new Date().toISOString().split('T')[0];
    pdf.save(`dodoco-fire-report-${safeId}-${timestamp}.pdf`);
  } finally {
    root.unmount();
    // Small delay before removing so React can cleanly unmount
    setTimeout(() => {
      if (document.body.contains(container)) {
        document.body.removeChild(container);
      }
    }, 200);
  }
}
