suppressPackageStartupMessages({
  library(ggplot2)
})

out_png <- "C:/GitHub/linkedin_profile/substack_assets/posts/2026-06-18-its-not-the-price-of-fruit/hero_age_vs_income.png"

## --- FRESH palette (skill tokens) ---
ink      <- "#1a3a2a"  # habitual emphasis
ink_line <- "#3a7a5a"  # per-day
muted    <- "#6b7b6b"
paper    <- "#fffdf8"
line_soft<- "#eee8df"

## --- fonts: use house fonts if installed, else graceful fallback ---
fams <- tryCatch(systemfonts::system_fonts()$family, error = function(e) character(0))
pick <- function(cands, fallback) { hit <- cands[cands %in% fams]; if (length(hit)) hit[1] else fallback }
base_family  <- pick(c("Source Sans 3", "Source Sans Pro", "Segoe UI"), "sans")
title_family <- pick(c("Lora", "Georgia"), base_family)

## --- data (within children 2-19); % meeting fruit rec, 90% UI ---
d <- read.csv(text = "
panel,xlab,series,est,lo,hi
Age,Age 2-3,Habitual,61.3,55.7,66.7
Age,Age 4-8,Habitual,37.3,33.3,41.2
Age,Age 9-15,Habitual,14.5,12.3,16.8
Age,Age 16-19,Habitual,6.3,4.7,7.8
Age,Age 2-3,Per-day,48.5,43.2,54.4
Age,Age 4-8,Per-day,30.4,27.1,33.9
Age,Age 9-15,Per-day,12.2,10.4,14.0
Age,Age 16-19,Per-day,6.0,4.7,7.4
Household income,Lower,Habitual,18.2,16.4,20.1
Household income,Middle,Habitual,21.6,19.7,23.7
Household income,Higher,Habitual,24.9,22.4,27.2
Household income,Lower,Per-day,15.1,13.7,16.5
Household income,Middle,Per-day,18.0,16.5,19.7
Household income,Higher,Per-day,20.4,18.4,22.5
", strip.white = TRUE)

d$panel <- factor(d$panel, levels = c("Age", "Household income"))
d$xlab  <- factor(d$xlab, levels = c("Age 2-3","Age 4-8","Age 9-15","Age 16-19",
                                     "Lower","Middle","Higher"))
d$series <- factor(d$series, levels = c("Habitual","Per-day"))
pal <- c(Habitual = ink, `Per-day` = ink_line)

## series direct-labels (age panel, at the top-left point)
labs_df <- subset(d, panel == "Age" & xlab == "Age 2-3")
labs_df$vjust <- ifelse(labs_df$series == "Habitual", -1.1, 1.9)

## spread annotations
ann <- read.csv(text = "
panel,xlab,y,txt
Age,Age 9-15,52,55-point drop across age
Household income,Middle,52,7-point rise across income
", strip.white = TRUE)
ann$panel <- factor(ann$panel, levels = levels(d$panel))
ann$xlab  <- factor(ann$xlab,  levels = levels(d$xlab))

p <- ggplot(d, aes(xlab, est, colour = series, group = series)) +
  geom_linerange(aes(ymin = lo, ymax = hi), linewidth = 3.2, alpha = 0.16) +
  geom_line(linewidth = 1.1) +
  geom_point(size = 2.7) +
  geom_text(data = labs_df, aes(label = series, vjust = vjust),
            family = base_family, fontface = "bold", hjust = 0.1, size = 4.4,
            show.legend = FALSE) +
  geom_text(data = ann, aes(xlab, y, label = txt), inherit.aes = FALSE,
            family = base_family, colour = muted, size = 3.5, fontface = "italic") +
  facet_wrap(~panel, scales = "free_x", nrow = 1) +
  scale_colour_manual(values = pal) +
  scale_y_continuous(limits = c(0, 70), breaks = seq(0, 60, 20),
                     labels = function(z) paste0(z, "%"),
                     expand = expansion(mult = c(0.01, 0.02))) +
  labs(
    title    = "Fruit adherence collapses with age — not with income",
    subtitle = "Share of U.S. children (2–19) meeting the fruit guideline, NHANES 2017–18.\nPanels share a y-axis; shaded bars are 90% intervals.",
    caption  = "Habitual = usual-intake model · Per-day = daily-compliance model · within-children marginals · n=7,125 · 2026-06-18",
    x = NULL, y = "Meeting fruit recommendation"
  ) +
  theme_minimal(base_size = 15, base_family = base_family) +
  theme(
    plot.title         = element_text(face = "bold", colour = ink, family = title_family,
                                       size = rel(1.1), margin = margin(b = 4)),
    plot.subtitle      = element_text(colour = muted, size = rel(0.82), margin = margin(b = 10)),
    plot.caption       = element_text(colour = "#9aaa9a", hjust = 0, size = rel(0.68),
                                       margin = margin(t = 10)),
    plot.background    = element_rect(fill = paper, colour = NA),
    panel.background   = element_rect(fill = paper, colour = NA),
    panel.grid.major.x = element_blank(),
    panel.grid.minor   = element_blank(),
    panel.grid.major.y = element_line(colour = line_soft, linewidth = 0.4),
    panel.spacing      = unit(1.6, "lines"),
    axis.title.y       = element_text(face = "bold", colour = "black", size = rel(0.85)),
    axis.text.x        = element_text(face = "bold", colour = "black", size = rel(0.92)),
    axis.text.y        = element_text(colour = "black"),
    axis.line          = element_line(colour = "black", linewidth = 0.9),
    axis.ticks         = element_line(colour = "black", linewidth = 0.7),
    strip.background   = element_blank(),
    strip.text         = element_text(hjust = 0, face = "bold", colour = ink, size = rel(1.0)),
    legend.position    = "none"
  )

dev_ok <- requireNamespace("ragg", quietly = TRUE)
ggsave(out_png, p, width = 9.6, height = 5.3, dpi = 600, bg = paper,
       device = if (dev_ok) ragg::agg_png else "png")
cat("WROTE", out_png, "\n")
