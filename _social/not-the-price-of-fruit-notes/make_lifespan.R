suppressPackageStartupMessages(library(ggplot2))
ink<-"#1a3a2a"; ink_line<-"#3a7a5a"; muted<-"#6b7b6b"; warm<-"#8a4a10"; paper<-"#fffdf8"; line_soft<-"#eee8df"
fams <- tryCatch(systemfonts::system_fonts()$family, error=function(e) character(0))
bf <- if ("Source Sans 3" %in% fams) "Source Sans 3" else if ("Segoe UI" %in% fams) "Segoe UI" else "sans"
tf <- if ("Lora" %in% fams) "Lora" else bf

d <- data.frame(
  x = 1:10,
  lab = c("2–3","4–8","9–15","16–20","20s","30s","40s","50s","60s","70+"),
  intake = c(1.291,1.110,0.837,0.659,0.725,0.793,0.873,0.899,0.922,0.982)
)
trough <- d[which.min(d$intake), ]

p <- ggplot(d, aes(x, intake)) +
  annotate("rect", xmin=3.5, xmax=4.5, ymin=0, ymax=1.4, fill="#f0ebe2", alpha=.55) +
  geom_line(colour=ink, linewidth=1.2) +
  geom_point(colour=ink, size=2.7) +
  geom_point(data=trough, colour=warm, size=3.4) +
  annotate("text", x=4, y=trough$intake-0.10, label="adolescent trough", colour=warm, fontface="bold", size=3.4, family=bf) +
  annotate("text", x=8, y=1.02, label="…then it climbs back, all the way to 70+", colour=muted, size=3.4, fontface="italic", family=bf) +
  annotate("segment", x=2.0, xend=1.1, y=1.20, yend=1.27, colour=muted, linewidth=.4,
           arrow=grid::arrow(length=unit(.12,"cm"))) +
  annotate("text", x=2.4, y=1.18, label="toddlers high", colour=muted, size=3.4, fontface="italic", family=bf) +
  scale_x_continuous(breaks=1:10, labels=d$lab, expand=expansion(mult=c(.03,.04))) +
  scale_y_continuous(limits=c(0,1.4), breaks=seq(0,1.2,.4)) +
  labs(title="Fruit intake doesn't keep falling with age — it's a U",
       subtitle="Mean usual fruit intake across the full lifespan, U.S. ages 2–80+ · NHANES 2017–18\nThe floor is adolescence; intake recovers steadily through adulthood",
       x="Age", y="Cup-equivalents / day",
       caption="If autonomy and market exposure (which only rise with age) drove the decline, 70-year-olds would be worst — they're nearly best.\nThe monotonic mechanisms can't make a U. Source: FRESH usual-intake model, NHANES 2017–18.") +
  theme_minimal(base_size=14, base_family=bf) +
  theme(plot.title=element_text(face="bold",colour=ink,family=tf,size=rel(1.05)),
        plot.subtitle=element_text(colour=muted,size=rel(.8),margin=margin(b=8)),
        plot.caption=element_text(colour="#9aaa9a",hjust=0,size=rel(.66),margin=margin(t=8)),
        plot.background=element_rect(fill=paper,colour=NA), panel.background=element_rect(fill=paper,colour=NA),
        panel.grid.minor=element_blank(), panel.grid.major.x=element_blank(),
        panel.grid.major.y=element_line(colour=line_soft,linewidth=.4),
        axis.title=element_text(face="bold",colour="black",size=rel(.82)),
        axis.text=element_text(colour="black"), axis.line=element_line(colour="black",linewidth=.8),
        axis.ticks=element_line(colour="black",linewidth=.6), legend.position="none")
ggsave("C:/GitHub/linkedin_profile/substack_assets/posts/2026-06-18-price-of-fruit-appendix/lifespan_ushape.png",
       p, width=8.4, height=5.0, dpi=300, bg=paper)
cat("WROTE lifespan_ushape.png\n")
