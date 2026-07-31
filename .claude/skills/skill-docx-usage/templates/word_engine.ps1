# 共用 Word 文档生成引擎——跟 mattpocock 那份文档用的是完全相同的排版逻辑
# 只负责定义函数，不会自己执行；由各个 xxx_data.ps1 dot-source 后调用 Build-SkillOverviewDoc
# 使用前记得给本文件和 data 脚本都加 UTF-8 BOM，见 SKILL.md 的 Failure modes

function Build-SkillOverviewDoc {
    param(
        [string]$OutPath,
        [string]$TitleMain,
        [string]$Subtitle,
        [string]$SourceLine,
        [string]$DateLine,
        [string]$WhatIsThisText,
        [string]$InvokeNoteText,
        [array]$Phases,        # 每项: @{ Title=''; Intro=''; Skills=@(@{Name='';Invoke='';Desc='';Tip=''}, ...) }
        [string]$EndingTitle,
        [array]$EndingLines,
        [string]$NoteLine
    )

    $ErrorActionPreference = 'Stop'
    $word = New-Object -ComObject Word.Application
    $word.Visible = $false
    $doc = $word.Documents.Add()
    $sel = $word.Selection

    # 强制 A4 纸张 + 2.5cm 页边距，让内容宽度可预测，表格才不会超出页面
    $doc.PageSetup.PaperSize = 7   # wdPaperA4
    $marginPt = [math]::Round(2.5 / 2.54 * 72, 1)
    $doc.PageSetup.TopMargin = $marginPt
    $doc.PageSetup.BottomMargin = $marginPt
    $doc.PageSetup.LeftMargin = $marginPt
    $doc.PageSetup.RightMargin = $marginPt
    $contentWidth = $doc.PageSetup.PageWidth - $doc.PageSetup.LeftMargin - $doc.PageSetup.RightMargin

    $STYLE_TITLE = -63
    $STYLE_H1 = -2
    $STYLE_NORMAL = -1

    function Add-Title($text) {
        $sel.EndKey(6) | Out-Null
        $sel.Style = $doc.Styles.Item($STYLE_TITLE)
        $sel.TypeText($text)
        $sel.TypeParagraph()
    }
    function Add-H1($text) {
        $sel.EndKey(6) | Out-Null
        $sel.Style = $doc.Styles.Item($STYLE_H1)
        $sel.TypeText($text)
        $sel.TypeParagraph()
    }
    function Add-Normal($text) {
        $sel.EndKey(6) | Out-Null
        $sel.Style = $doc.Styles.Item($STYLE_NORMAL)
        $sel.TypeText($text)
        $sel.TypeParagraph()
    }
    function Add-SkillTable($skills) {
        $sel.EndKey(6) | Out-Null
        $sel.Style = $doc.Styles.Item($STYLE_NORMAL)
        $startRange = $sel.Range
        $rows = $skills.Count + 1
        $tbl = $doc.Tables.Add($startRange, $rows, 4)
        $tbl.Borders.Enable = $true
        $tbl.AutoFitBehavior(0)   # wdAutoFitFixed：固定列宽，不再被自动调整覆盖
        $tbl.PreferredWidthType = 3   # wdPreferredWidthPoints
        $tbl.PreferredWidth = $contentWidth

        $ratios = @(95, 75, 175, 175)
        $ratioSum = ($ratios | Measure-Object -Sum).Sum
        $usable = $contentWidth - 4
        for ($c = 1; $c -le 4; $c++) {
            $tbl.Columns.Item($c).Width = [math]::Round($usable * $ratios[$c-1] / $ratioSum, 1)
        }

        $tbl.Cell(1,1).Range.Text = '技能'
        $tbl.Cell(1,2).Range.Text = '调用方式'
        $tbl.Cell(1,3).Range.Text = '这是做什么的'
        $tbl.Cell(1,4).Range.Text = '在这个网站项目中怎么用'
        $tbl.Rows.Item(1).Range.Font.Bold = $true
        $tbl.Rows.Item(1).HeadingFormat = $true

        $r = 2
        foreach ($s in $skills) {
            $tbl.Cell($r,1).Range.Text = $s.Name
            $tbl.Cell($r,2).Range.Text = $s.Invoke
            $tbl.Cell($r,3).Range.Text = $s.Desc
            $tbl.Cell($r,4).Range.Text = $s.Tip
            $r++
        }
        $sel.EndKey(6) | Out-Null
        $sel.TypeParagraph()
    }

    # ---------- 标题页 ----------
    Add-Title $TitleMain
    Add-Normal $Subtitle
    Add-Normal $SourceLine
    Add-Normal $DateLine
    Add-Normal ''

    Add-H1 '这份文档是什么'
    Add-Normal $WhatIsThisText
    Add-Normal $InvokeNoteText

    # ---------- 各阶段 ----------
    foreach ($p in $Phases) {
        if ($p.Skills.Count -eq 0) { continue }
        Add-H1 $p.Title
        Add-Normal $p.Intro
        Add-SkillTable $p.Skills
    }

    # ---------- 使用建议 ----------
    if ($EndingTitle) {
        Add-H1 $EndingTitle
        foreach ($line in $EndingLines) { Add-Normal $line }
    }
    if ($NoteLine) {
        Add-Normal ''
        Add-Normal $NoteLine
    }

    $word.Options.CheckGrammarAsYouType = $false
    $word.Options.CheckSpellingAsYouType = $false
    $doc.SaveAs2($OutPath, 16)
    $doc.Close()
    $word.Quit()
    [System.Runtime.InteropServices.Marshal]::ReleaseComObject($word) | Out-Null
    Write-Output "DONE: $OutPath"
}
