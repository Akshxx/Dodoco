import { researchArticles } from '@/data/mockData';
import { FileText, ExternalLink } from 'lucide-react';

const ResearchArticles = () => (
  <section id="research" className="my-8">
    <h2 className="text-xl font-heading font-bold mb-4">Research & Reports</h2>
    <div className="space-y-2">
      {researchArticles.map((a, i) => (
        <a
          key={i}
          href={a.url}
          target="_blank"
          rel="noopener noreferrer"
          className="glass-card p-4 flex items-start gap-3 card-hover-lift cursor-pointer no-underline block"
          style={{ textDecoration: 'none', color: 'inherit' }}
        >
          <FileText className="w-5 h-5 text-primary flex-shrink-0 mt-0.5" />
          <div className="min-w-0 flex-1">
            <p className="text-sm font-medium leading-snug">{a.title}</p>
            <div className="flex gap-2 text-xs text-muted-foreground mt-1 items-center">
              <span className="font-mono">{a.source}</span>
              <span>•</span>
              <span>{a.time}</span>
            </div>
          </div>
          <ExternalLink className="w-3.5 h-3.5 text-muted-foreground flex-shrink-0 mt-1 opacity-60" />
        </a>
      ))}
    </div>
  </section>
);

export default ResearchArticles;
