"""
Generates docs/Project-Explained-Simply.pdf -- the whole project explained
the way you would explain it to a ten-year-old.

    python tools/make-explainer-pdf.py

Deliberately avoids Unicode arrows and sub/superscripts: ReportLab's built-in
fonts have no glyphs for them and they render as black boxes.
"""

import os
from reportlab.lib.pagesizes import A4
from reportlab.lib.units import mm
from reportlab.lib.colors import HexColor, white
from reportlab.lib.styles import ParagraphStyle
from reportlab.lib.enums import TA_CENTER
from reportlab.platypus import (
    BaseDocTemplate, PageTemplate, Frame, Paragraph, Spacer,
    Table, TableStyle, Flowable, PageBreak, KeepTogether,
)

# --- palette ---------------------------------------------------------------
INK    = HexColor('#1B2A33')
DIM    = HexColor('#5C7080')
TEAL   = HexColor('#0F9E8C')
BLUE   = HexColor('#3A6FD0')
ORANGE = HexColor('#E07B39')
PINK   = HexColor('#CC5A8A')
PALE   = HexColor('#EEF4F6')
PALE2  = HexColor('#FFF4EA')
RULE   = HexColor('#D3E0E6')

PAGE_W, PAGE_H = A4
MARGIN = 20 * mm
CONTENT_W = PAGE_W - 2 * MARGIN

# --- styles ----------------------------------------------------------------
def style(name, **kw):
    base = dict(fontName='Helvetica', fontSize=12, leading=18, textColor=INK,
                spaceAfter=9)
    base.update(kw)
    return ParagraphStyle(name, **base)

S_TITLE   = style('title', fontName='Helvetica-Bold', fontSize=33, leading=38,
                  textColor=INK, alignment=TA_CENTER, spaceAfter=6)
S_SUB     = style('sub', fontSize=14.5, leading=21, textColor=DIM,
                  alignment=TA_CENTER, spaceAfter=4)
S_TAG     = style('tag', fontSize=10.5, leading=15, textColor=TEAL,
                  alignment=TA_CENTER, fontName='Helvetica-Bold')
S_H1      = style('h1', fontName='Helvetica-Bold', fontSize=21, leading=26,
                  textColor=TEAL, spaceAfter=3, spaceBefore=0)
S_KICKER  = style('kicker', fontName='Helvetica-Bold', fontSize=10, leading=13,
                  textColor=ORANGE, spaceAfter=10)
S_BODY    = style('body', fontSize=12.3, leading=18.5, spaceAfter=10)
S_BIG     = style('big', fontSize=15, leading=22, fontName='Helvetica-Bold',
                  textColor=INK, spaceAfter=10)
S_CALL    = style('call', fontSize=14, leading=20, fontName='Helvetica-Bold',
                  textColor=INK, spaceAfter=0)
S_CAP     = style('cap', fontSize=10.5, leading=15, textColor=DIM,
                  alignment=TA_CENTER, spaceAfter=2)
S_CELL    = style('cell', fontSize=11, leading=15, spaceAfter=0)
S_CELLB   = style('cellb', fontSize=11, leading=15, spaceAfter=0,
                  fontName='Helvetica-Bold')
# The glossary is 18 rows; it needs to be tighter than the other tables so the
# closing note stays on the same page instead of stranding a near-empty one.
S_GLOSS   = style('gloss', fontSize=10.2, leading=13, spaceAfter=0)
S_GLOSSB  = style('glossb', fontSize=10.2, leading=13, spaceAfter=0,
                  fontName='Helvetica-Bold')
S_NUM     = style('num', fontName='Helvetica-Bold', fontSize=20, leading=22,
                  textColor=white, alignment=TA_CENTER, spaceAfter=0)


def callout(text, bg=PALE, bar=TEAL):
    """A tinted box with a coloured bar down the left edge."""
    t = Table([[Paragraph(text, S_CALL)]], colWidths=[CONTENT_W])
    t.setStyle(TableStyle([
        ('BACKGROUND',   (0, 0), (-1, -1), bg),
        ('LINEBEFORE',   (0, 0), (0, -1), 3.5, bar),
        ('LEFTPADDING',  (0, 0), (-1, -1), 15),
        ('RIGHTPADDING', (0, 0), (-1, -1), 15),
        ('TOPPADDING',   (0, 0), (-1, -1), 13),
        ('BOTTOMPADDING', (0, 0), (-1, -1), 13),
    ]))
    return t


def numbered(n, heading, body, colour):
    """A numbered circle beside a heading and paragraph."""
    circ = Table([[Paragraph(str(n), S_NUM)]], colWidths=[26], rowHeights=[26])
    circ.setStyle(TableStyle([
        ('BACKGROUND', (0, 0), (-1, -1), colour),
        ('VALIGN', (0, 0), (-1, -1), 'MIDDLE'),
        ('LEFTPADDING', (0, 0), (-1, -1), 0),
        ('RIGHTPADDING', (0, 0), (-1, -1), 0),
        ('TOPPADDING', (0, 0), (-1, -1), 3),
        ('BOTTOMPADDING', (0, 0), (-1, -1), 0),
    ]))
    txt = [Paragraph('<b>' + heading + '</b>', style(
        'nh', fontName='Helvetica-Bold', fontSize=13.5, leading=17,
        textColor=colour, spaceAfter=4)),
        Paragraph(body, style('nb', fontSize=11.8, leading=17, spaceAfter=0))]
    t = Table([[circ, txt]], colWidths=[36, CONTENT_W - 36])
    t.setStyle(TableStyle([
        ('VALIGN', (0, 0), (-1, -1), 'TOP'),
        ('LEFTPADDING', (0, 0), (-1, -1), 0),
        ('RIGHTPADDING', (0, 0), (-1, -1), 0),
        ('TOPPADDING', (0, 0), (-1, -1), 0),
        ('BOTTOMPADDING', (0, 0), (-1, -1), 16),
    ]))
    return t


# --- diagrams --------------------------------------------------------------
class Draw(Flowable):
    def __init__(self, height, fn):
        Flowable.__init__(self)
        self.width = CONTENT_W
        self.height = height
        self.fn = fn

    def draw(self):
        self.fn(self.canv, self.width, self.height)


def _note(c, x, y, label, colour, w=62, h=24):
    c.setFillColor(colour)
    c.roundRect(x, y, w, h, 5, stroke=0, fill=1)
    c.setFillColor(white)
    c.setFont('Helvetica-Bold', 9.5)
    c.drawCentredString(x + w / 2., y + 8.5, label)


def _lane(c, x, y, w, title):
    c.setFillColor(DIM)
    c.setFont('Helvetica-Bold', 9)
    c.drawString(x, y + 34, title)
    c.setStrokeColor(RULE)
    c.setLineWidth(1)
    c.line(x, y, x + w, y)
    # little tick marks so the lane reads as a time-line
    for i in range(0, 6):
        tx = x + i * (w / 5.)
        c.line(tx, y, tx, y - 4)
    c.setFillColor(DIM)
    c.setFont('Helvetica', 8)
    c.drawString(x, y - 15, 'time')


# Shared geometry for the two "what each person hears" diagrams. Both use the
# same lane positions so the reader can compare them page to page, and the
# values are chosen so no label lands on top of another.
LANE_TOP = 52     # baseline of the upper lane, measured down from the top
LANE_BOT = 134    # baseline of the lower lane
DIAG_H = 190      # total flowable height these positions assume


def diagram_problem(c, w, h):
    """What each player hears when nothing is compensated."""
    lane_w = w - 40
    x = 20

    _lane(c, x, h - LANE_TOP, lane_w, 'WHAT YOU HEAR')
    _note(c, x, h - LANE_TOP + 6, 'you', BLUE)
    _note(c, x + 118, h - LANE_TOP + 6, 'friend', ORANGE)

    _lane(c, x, h - LANE_BOT, lane_w, 'WHAT THEY HEAR')
    _note(c, x, h - LANE_BOT + 6, 'friend', ORANGE)
    _note(c, x + 118, h - LANE_BOT + 6, 'you', BLUE)

    c.setFillColor(PINK)
    c.setFont('Helvetica-Bold', 10)
    c.drawCentredString(w / 2., 6, 'You both think the OTHER one is late.')


def diagram_fix(c, w, h):
    """The same two players once everyone waits the same amount."""
    lane_w = w - 40
    x = 20
    shift = 118

    _lane(c, x, h - LANE_TOP, lane_w, 'WHAT YOU HEAR')
    _note(c, x + shift, h - LANE_TOP + 6, 'you', BLUE)
    _note(c, x + shift + 66, h - LANE_TOP + 6, 'friend', ORANGE)

    _lane(c, x, h - LANE_BOT, lane_w, 'WHAT THEY HEAR')
    _note(c, x + shift, h - LANE_BOT + 6, 'you', BLUE)
    _note(c, x + shift + 66, h - LANE_BOT + 6, 'friend', ORANGE)

    # The shared waiting period, marked once across both lanes. The label sits
    # in the gap between the upper lane's "time" caption and the lower lane's
    # title, which is the only horizontal band on the diagram that is free.
    c.setStrokeColor(TEAL)
    c.setLineWidth(1)
    c.setDash(3, 3)
    c.line(x + shift, h - 26, x + shift, h - LANE_BOT - 6)
    c.setDash()
    c.setFillColor(TEAL)
    c.setFont('Helvetica-Bold', 8)
    c.drawCentredString(x + shift / 2., h - 85, 'everyone waits this long')

    c.setFillColor(TEAL)
    c.setFont('Helvetica-Bold', 10)
    c.drawCentredString(w / 2., 6, 'Both people hear exactly the same thing. It works.')


def diagram_mesh(c, w, h):
    """Cover art: three peers, a server that steps aside."""
    cx, cy, r = w / 2., h / 2. - 6, 62
    pts = [(cx, cy + r), (cx - r * 0.93, cy - r * 0.55), (cx + r * 0.93, cy - r * 0.55)]

    c.setStrokeColor(TEAL)
    c.setLineWidth(2)
    for i in range(3):
        for j in range(i + 1, 3):
            c.line(pts[i][0], pts[i][1], pts[j][0], pts[j][1])

    cols = [BLUE, ORANGE, PINK]
    for (px, py), col in zip(pts, cols):
        c.setFillColor(white)
        c.circle(px, py, 21, stroke=0, fill=1)
        c.setFillColor(col)
        c.circle(px, py, 17, stroke=0, fill=1)

    c.setFillColor(DIM)
    c.setFont('Helvetica', 9.5)
    c.drawCentredString(cx, cy - r - 34, 'music travels straight between friends')


# --- page furniture --------------------------------------------------------
def on_page(canvas, doc):
    canvas.saveState()
    if doc.page > 1:
        canvas.setStrokeColor(RULE)
        canvas.setLineWidth(0.8)
        canvas.line(MARGIN, MARGIN - 8, PAGE_W - MARGIN, MARGIN - 8)
        canvas.setFillColor(DIM)
        canvas.setFont('Helvetica', 8.5)
        canvas.drawString(MARGIN, MARGIN - 20, 'The Long-Distance Band')
        canvas.drawRightString(PAGE_W - MARGIN, MARGIN - 20, str(doc.page))
    canvas.restoreState()


def build():
    here = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    out = os.path.join(here, 'docs', 'Project-Explained-Simply.pdf')

    doc = BaseDocTemplate(
        out, pagesize=A4,
        leftMargin=MARGIN, rightMargin=MARGIN,
        topMargin=MARGIN, bottomMargin=MARGIN + 8,
        title='The Long-Distance Band',
        author='Distributed Systems FA-1',
        subject='The whole project, explained simply',
    )
    frame = Frame(MARGIN, MARGIN + 8, CONTENT_W,
                  PAGE_H - 2 * MARGIN - 8, id='main',
                  leftPadding=0, rightPadding=0, topPadding=0, bottomPadding=0)
    doc.addPageTemplates([PageTemplate(id='p', frames=[frame], onPage=on_page)])

    S = []

    # ---------------- cover ----------------
    S += [Spacer(1, 52)]
    S += [Paragraph('The Long-Distance Band', S_TITLE)]
    S += [Spacer(1, 8)]
    S += [Paragraph('How we got friends in different houses<br/>to play music together, in time', S_SUB)]
    S += [Spacer(1, 26)]
    S += [Draw(190, diagram_mesh)]
    S += [Spacer(1, 26)]
    S += [Paragraph('A DISTRIBUTED SYSTEMS PROJECT, EXPLAINED SIMPLY', S_TAG)]
    S += [Spacer(1, 40)]
    S += [callout(
        'Everything in here is true and really works. We just took out the '
        'complicated words and put them at the back, so you can meet the '
        'ideas first.', PALE2, ORANGE)]
    S += [PageBreak()]

    # ---------------- 1. what we made ----------------
    S += [Paragraph('THE IDEA', S_KICKER)]
    S += [Paragraph('What we made', S_H1)]
    S += [Spacer(1, 10)]
    S += [Paragraph(
        'Imagine you play the drums and your best friend plays guitar. You '
        'want to play a song together. But you are in your house, and they '
        'are in theirs.', S_BODY)]
    S += [Paragraph(
        'You could try a video call. People do try. It sounds <b>awful</b>. '
        'You start together, then you drift apart, then you both slow down '
        'trying to fix it, and the song falls to pieces.', S_BODY)]
    S += [Paragraph(
        'It is not because you are bad at music. It is because of something '
        'sneaky that the internet does, and almost nobody notices it.', S_BODY)]
    S += [Spacer(1, 6)]
    S += [callout('We built a program that fixes it. This is how.')]
    S += [PageBreak()]

    # ---------------- 2. why hard ----------------
    S += [Paragraph('THE PROBLEM', S_KICKER)]
    S += [Paragraph('Why is this so hard?', S_H1)]
    S += [Spacer(1, 10)]
    S += [Paragraph(
        'When you hit a drum, you hear it <b>instantly</b>. It happened right '
        'next to your ears.', S_BODY)]
    S += [Paragraph(
        'But that sound has to travel all the way to your friend. That takes '
        'a moment. Not long, but long enough to matter, because music needs '
        'everybody to land on the beat together.', S_BODY)]
    S += [Paragraph('So here is what actually happens:', S_BODY)]
    S += [Spacer(1, 4)]
    S += [Draw(DIAG_H, diagram_problem)]
    S += [Spacer(1, 14)]
    S += [Paragraph(
        'Look carefully. <b>You</b> hear yourself first and your friend late. '
        'Your <b>friend</b> hears themselves first and you late.', S_BODY)]
    S += [Paragraph(
        'So you slow down to wait for them. And they slow down to wait for '
        'you. And you both keep waiting for each other, slower and slower, '
        'until the song is a puddle on the floor.', S_BODY)]
    S += [Spacer(1, 4)]
    S += [callout('You are each hearing a <i>different</i> version of the '
                  'same song.', PALE2, PINK)]
    S += [PageBreak()]

    # ---------------- 3. big idea ----------------
    S += [Paragraph('THE CLEVER BIT', S_KICKER)]
    S += [Paragraph('The surprising fix', S_H1)]
    S += [Spacer(1, 10)]
    S += [Paragraph(
        'You would think the answer is "make the internet faster". It is not. '
        'We cannot make it faster, and anyway that is not really the problem.', S_BODY)]
    S += [Paragraph('Instead we did something that sounds silly at first:', S_BODY)]
    S += [Spacer(1, 2)]
    S += [callout('We made <b>everybody late</b>. On purpose. By exactly the '
                  'same amount.')]
    S += [Spacer(1, 14)]
    S += [Paragraph(
        'Think about a school assembly. If you sit right at the back, the '
        'teacher\'s voice reaches you a tiny bit late. Does that ruin '
        'assembly? Of course not. Everyone near you is hearing it late too. '
        'You are all late <b>together</b>, so it feels completely normal.', S_BODY)]
    S += [Paragraph(
        'That is the whole secret. Being late does not ruin music. Being late '
        'by <b>different amounts</b> ruins music.', S_BODY)]
    S += [Spacer(1, 6)]
    S += [Draw(DIAG_H, diagram_fix)]
    S += [Spacer(1, 12)]
    S += [Paragraph(
        'So our program keeps checking how slow the slowest connection is, '
        'and then makes everyone wait exactly that long. Even you, listening '
        'to your own drums.', S_BODY)]
    S += [Paragraph(
        'Yes, that means you hear your own drums slightly late, which feels '
        'strange for about a minute. Then your brain stops noticing, and the '
        'band is together. That is the trade we chose.', S_BODY)]
    S += [PageBreak()]

    # ---------------- 4. helpers ----------------
    S += [Paragraph('HOW IT WORKS', S_KICKER)]
    S += [Paragraph('The four helpers', S_H1)]
    S += [Spacer(1, 4)]
    S += [Paragraph(
        'Our program has four helpers, and each one has exactly one job.', S_BODY)]
    S += [Spacer(1, 8)]
    S += [numbered(1, 'The Receptionist',
                   'You walk up and ask one question: "Can I join the band?" '
                   'The receptionist answers straight away: "Yes, you are '
                   'player number 2, and here is who else is here." One '
                   'question, one answer.', BLUE)]
    S += [numbered(2, 'The Announcer',
                   'Stands on a chair and shouts to the whole room: "New '
                   'speed, 140 beats a minute!" Everyone hears it at once, '
                   'and nobody has to be asked. Best part: if you arrive '
                   'late, the announcer immediately tells you what you '
                   'missed, so you are never left standing there confused.', ORANGE)]
    S += [numbered(3, 'The Direct Line',
                   'Once two friends know about each other, they get their '
                   'own private phone line, and the music goes straight down '
                   'it. It does not stop anywhere on the way. Every extra '
                   'stop would make the music later, and later is the enemy.', PINK)]
    S += [numbered(4, 'The Counting Rule',
                   'This is the cleverest helper of all, so it gets its own '
                   'page. Turn over.', TEAL)]
    S += [PageBreak()]

    # ---------------- 5. counting rule ----------------
    S += [Paragraph('THE BEST BIT', S_KICKER)]
    S += [Paragraph('The counting rule', S_H1)]
    S += [Spacer(1, 10)]
    S += [Paragraph(
        'Every band needs to agree on when the beats happen. Here are two '
        'ways to do that.', S_BODY)]
    S += [Spacer(1, 2)]

    rows = [
        [Paragraph('<b>The slow way</b>', S_CELLB),
         Paragraph('One computer shouts "CLAP!... CLAP!... CLAP!" and everybody '
                   'claps when they hear it.<br/><br/>'
                   '<font color="#CC5A8A">Problem: if one shout gets lost or turns up '
                   'late, somebody claps in the wrong place. And if the shouter '
                   'goes away, everything stops dead.</font>', S_CELL)],
        [Paragraph('<b>Our way</b>', S_CELLB),
         Paragraph('We send <b>one</b> message: "Start at exactly 3 o\'clock, '
                   'and clap every half second."<br/><br/>'
                   '<font color="#0F9E8C">Now everyone can work out every single clap '
                   'by themselves, forever. Nobody ever needs telling again.</font>', S_CELL)],
    ]
    t = Table(rows, colWidths=[95, CONTENT_W - 95])
    t.setStyle(TableStyle([
        ('VALIGN', (0, 0), (-1, -1), 'TOP'),
        ('BACKGROUND', (0, 0), (-1, 0), PALE2),
        ('BACKGROUND', (0, 1), (-1, 1), PALE),
        ('LEFTPADDING', (0, 0), (-1, -1), 12),
        ('RIGHTPADDING', (0, 0), (-1, -1), 12),
        ('TOPPADDING', (0, 0), (-1, -1), 12),
        ('BOTTOMPADDING', (0, 0), (-1, -1), 12),
        ('LINEBELOW', (0, 0), (-1, 0), 6, white),
    ]))
    S += [t]
    S += [Spacer(1, 16)]
    S += [callout('It is the difference between being fed one spoonful at a '
                  'time, and being handed the recipe.')]
    S += [Spacer(1, 14)]
    S += [Paragraph(
        '<b>But hang on.</b> What if your clock and your friend\'s clock do '
        'not agree? Then "3 o\'clock" means different things and the whole '
        'plan collapses.', S_BODY)]
    S += [Paragraph(
        'So before anything else, every computer checks its clock against one '
        'main clock, the way you might set your watch by the big clock at the '
        'station. It even allows for how long the checking itself took.', S_BODY)]
    S += [PageBreak()]

    # ---------------- 6. someone leaves ----------------
    S += [Paragraph('WHEN THINGS GO WRONG', S_KICKER)]
    S += [Paragraph('What if somebody disappears?', S_H1)]
    S += [Spacer(1, 10)]
    S += [Paragraph(
        'One computer is the <b>leader</b>. It decides when the counting '
        'starts and how fast it goes.', S_BODY)]
    S += [Paragraph(
        'So what happens if the leader\'s laptop runs out of battery in the '
        'middle of the song?', S_BODY)]
    S += [Spacer(1, 2)]
    S += [callout('Nothing. The music just carries on.', PALE, TEAL)]
    S += [Spacer(1, 14)]
    S += [Paragraph(
        'This is why the counting rule matters so much. Everyone already has '
        'the recipe, so nobody needs the leader in order to keep playing. The '
        'leader could vanish and you would not hear a single hiccup.', S_BODY)]
    S += [Paragraph(
        'Meanwhile, every computer quietly says "still here!" every couple of '
        'seconds, a bit like a register being taken over and over. If someone '
        'stops answering for about six seconds, everybody agrees they have '
        'gone.', S_BODY)]
    S += [Paragraph(
        'Then whoever has been in the band longest becomes the new leader. '
        'There is no argument and no vote, because everyone works it out the '
        'same way and so everyone picks the same person.', S_BODY)]
    S += [Spacer(1, 6)]
    S += [callout('In our demo you can close the leader\'s window on purpose. '
                  'The song does not even flinch.', PALE2, ORANGE)]
    S += [PageBreak()]

    # ---------------- 7. names ----------------
    S += [Paragraph('WHO IS WHO', S_KICKER)]
    S += [Paragraph('Three ways to say who you are', S_H1)]
    S += [Spacer(1, 10)]
    S += [Paragraph('Think about school for a second.', S_BODY)]

    rows = [
        [Paragraph('<b>Your name</b>', S_CELLB),
         Paragraph('"Sam." Friendly and easy to say. But there might be three '
                   'Sams in your class, and you could change it.', S_CELL)],
        [Paragraph('<b>Your roll number</b>', S_CELLB),
         Paragraph('"24." Boring, but there is only one of you, and it never '
                   'ever changes.', S_CELL)],
        [Paragraph('<b>Your address</b>', S_CELLB),
         Paragraph('Where you actually live, so people can reach you. And it '
                   'changes if you move house.', S_CELL)],
    ]
    t = Table(rows, colWidths=[125, CONTENT_W - 125])
    t.setStyle(TableStyle([
        ('VALIGN', (0, 0), (-1, -1), 'TOP'),
        ('BACKGROUND', (0, 0), (0, -1), PALE),
        ('LEFTPADDING', (0, 0), (-1, -1), 12),
        ('RIGHTPADDING', (0, 0), (-1, -1), 12),
        ('TOPPADDING', (0, 0), (-1, -1), 11),
        ('BOTTOMPADDING', (0, 0), (-1, -1), 11),
        ('LINEBELOW', (0, 0), (-1, -2), 3, white),
    ]))
    S += [t]
    S += [Spacer(1, 16)]
    S += [Paragraph(
        'Computers need all three as well, and people mix them up constantly.', S_BODY)]
    S += [Paragraph(
        'Our program always uses the <b>roll number</b> and never the '
        'address. Here is why that matters: a laptop can unplug from wifi and '
        'plug into a cable, which changes its address completely. It is still '
        'the same laptop and the same musician. If we had used the address, '
        'we would have lost them.', S_BODY)]
    S += [Spacer(1, 4)]
    S += [callout('Names are for humans. Roll numbers are for keeping track. '
                  'Addresses are just where to knock.')]
    S += [PageBreak()]

    # ---------------- 8. concurrent ----------------
    S += [Paragraph('A PUZZLE', S_KICKER)]
    S += [Paragraph('Did that happen because of you?', S_H1)]
    S += [Spacer(1, 10)]
    S += [Paragraph(
        'Two children in a playground both shout "GO!" at the same moment. '
        'Neither of them heard the other one first.', S_BODY)]
    S += [Paragraph('So who shouted first?', S_BIG)]
    S += [Paragraph(
        'It is a trick question. There is no answer, and that is not because '
        'the question is hard. It is because it is not a real question. '
        'Neither shout caused the other. They just both happened.', S_BODY)]
    S += [Spacer(1, 2)]
    S += [callout('Computers call this <b>concurrent</b>: two things that '
                  'happened without either one knowing about the other.',
                  PALE2, PINK)]
    S += [Spacer(1, 14)]
    S += [Paragraph(
        'You cannot solve this with clocks, because the clocks disagree. So '
        'instead every computer keeps a little counter, and passes it along '
        'with each message. By comparing counters we can always tell the '
        'difference between "this happened <b>because of</b> that" and "these '
        'two just both happened".', S_BODY)]
    S += [Paragraph(
        'The lovely part is that you can watch it change. When the connection '
        'is fast, one player really does hear the other before playing, so '
        'the notes are genuinely in order. Add a delay, and now neither one '
        'can possibly have heard the other, so the notes become concurrent.', S_BODY)]
    S += [Spacer(1, 4)]
    S += [callout('The network decides which one it is. You can see it flip '
                  'on the screen, live.')]
    S += [PageBreak()]

    # ---------------- 9. the show ----------------
    S += [Paragraph('THE DEMONSTRATION', S_KICKER)]
    S += [Paragraph('What you will see', S_H1)]
    S += [Spacer(1, 10)]

    steps = [
        ('Two players join', 'Both screens show both names appearing. They have found each other.'),
        ('Press start', 'Both computers begin counting the beat, perfectly together.'),
        ('Play together', 'It works. This is the boring bit, and boring is the goal.'),
        ('Break it on purpose', 'We add a delay to one connection and switch the clever trick off. The band falls apart, and you can hear it happen.'),
        ('Fix it', 'Switch the trick back on. Everything snaps back together.'),
        ('Change the speed', 'Change it on one laptop. The other one changes too, straight away.'),
        ('Kill the leader', 'Close the leader\'s window. The music keeps going, and a new leader takes over by itself.'),
        ('Look at the numbers', 'Every measurement is on screen the whole time: how slow each connection is, how long everyone is waiting, which beat we are on.'),
    ]
    rows = []
    for i, (h, b) in enumerate(steps, 1):
        rows.append([
            Paragraph('<font color="#0F9E8C"><b>' + str(i) + '</b></font>', S_CELLB),
            Paragraph('<b>' + h + '</b><br/>' + b, S_CELL),
        ])
    t = Table(rows, colWidths=[24, CONTENT_W - 24])
    t.setStyle(TableStyle([
        ('VALIGN', (0, 0), (-1, -1), 'TOP'),
        ('LEFTPADDING', (0, 0), (-1, -1), 4),
        ('RIGHTPADDING', (0, 0), (-1, -1), 4),
        ('TOPPADDING', (0, 0), (-1, -1), 9),
        ('BOTTOMPADDING', (0, 0), (-1, -1), 9),
        ('LINEBELOW', (0, 0), (-1, -2), 0.7, RULE),
    ]))
    S += [t]
    S += [Spacer(1, 16)]
    S += [callout('The best moment is number 4. Breaking something on '
                  'purpose, in front of everyone, is the clearest way to '
                  'prove the fix was doing something all along.', PALE2, ORANGE)]
    S += [PageBreak()]

    # ---------------- 10. glossary ----------------
    S += [Paragraph('FOR THE GROWN-UPS', S_KICKER)]
    S += [Paragraph('The proper words', S_H1)]
    S += [Spacer(1, 4)]
    S += [Paragraph(
        'Everything in this booklet is real. Here are the words the textbook '
        'uses for each idea, so you can find them again.', S_BODY)]
    S += [Spacer(1, 8)]

    gloss = [
        ('The Receptionist', 'Remote Procedure Call (gRPC)'),
        ('The Announcer', 'Message-Oriented Communication (MQTT, publish/subscribe)'),
        ('Telling latecomers what they missed', 'Retained messages'),
        ('The Direct Line', 'Peer-to-peer communication (WebRTC)'),
        ('Introducing two computers to each other', 'Signalling (offer, answer, ICE)'),
        ('Music flowing continuously', 'Stream-oriented communication'),
        ('The Counting Rule', 'Shared timeline from an anchor'),
        ('Setting your watch by the station clock', "Cristian's algorithm (clock synchronisation)"),
        ('Making everyone equally late', 'Latency compensation'),
        ('The leader', 'Timing master'),
        ('"Still here!" every two seconds', 'Heartbeat and failure detection'),
        ('Longest-serving player takes over', 'Deterministic succession'),
        ('Name, roll number, address', 'Names, identifiers and addresses'),
        ('"Both happened, neither caused the other"', 'Concurrent events, happened-before'),
        ('The little counters on messages', 'Lamport and vector clocks'),
        ('Helpers that carry messages for you', 'Middleware'),
        ('Music and sound over a network', 'Distributed multimedia system'),
    ]
    rows = [[Paragraph('<b>In this booklet</b>', S_GLOSSB),
             Paragraph('<b>The proper name</b>', S_GLOSSB)]]
    for a, b in gloss:
        rows.append([Paragraph(a, S_GLOSS),
                     Paragraph('<font color="#3A6FD0">' + b + '</font>', S_GLOSS)])
    t = Table(rows, colWidths=[CONTENT_W * 0.45, CONTENT_W * 0.55], repeatRows=1)
    t.setStyle(TableStyle([
        ('VALIGN', (0, 0), (-1, -1), 'TOP'),
        ('BACKGROUND', (0, 0), (-1, 0), PALE),
        ('LEFTPADDING', (0, 0), (-1, -1), 9),
        ('RIGHTPADDING', (0, 0), (-1, -1), 9),
        ('TOPPADDING', (0, 0), (-1, -1), 4.5),
        ('BOTTOMPADDING', (0, 0), (-1, -1), 4.5),
        ('LINEBELOW', (0, 0), (-1, -1), 0.6, RULE),
    ]))
    S += [t]
    S += [Spacer(1, 13)]
    S += [callout('One last honest note: this does not work over any distance '
                  'at all. If the connection is really bad, everyone has to '
                  'wait so long that the music stops feeling like music. Our '
                  'trick buys <b>agreement</b>, not speed.', PALE2, PINK)]

    doc.build(S)
    return out


if __name__ == '__main__':
    print('wrote', build())
