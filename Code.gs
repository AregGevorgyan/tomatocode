function onOpen(e) {
  SlidesApp.getUi()
    .createAddonMenu()
    .addItem('Open PearCode Sidebar', 'showSidebar')
    .addToUi();
}

function onInstall(e) {
  onOpen(e);
}

function showSidebar() {
  const html = HtmlService.createHtmlOutputFromFile('Sidebar')
    .setTitle('PearCode Question')
    .setWidth(300);
  SlidesApp.getUi().showSidebar(html);
}

function openEmptyQuestionDialog() {
  const html = HtmlService.createHtmlOutputFromFile('QuestionDialog')
    .setWidth(400)
    .setHeight(220);

  SlidesApp.getUi().showModalDialog(html, 'Create PearCode Question');
}

function addInteractiveSlideMarker() {
  const presentation = SlidesApp.getActivePresentation();
  const slide = presentation.getSelection().getCurrentPage();
  
  // Get slide dimensions
  const pageWidth = presentation.getPageWidth();
  const pageHeight = presentation.getPageHeight();
  
  // Box dimensions and positioning
  const boxHeight = 50; // Height of the green box
  const boxTop = pageHeight - boxHeight; // Position at bottom of slide
  
  // Adding a dark green box to the slide
  const shape = slide.insertShape(
    SlidesApp.ShapeType.RECTANGLE,
    0,            // left position
    boxTop,       // top position
    pageWidth,    // width
    boxHeight     // height
  );
  
  // Style the box
  shape.getText().setText('Answer the above coding question!');
  shape.getFill().setSolidFill('#006400');
  shape.getText().getTextStyle()
    .setForegroundColor('#FFFFFF')
    .setBold(true);
  shape.getBorder().setTransparent();
  
  // Mark slide using document properties
  const properties = PropertiesService.getDocumentProperties();
  const markedSlides = JSON.parse(properties.getProperty('pearcode_slides') || '[]');
  markedSlides.push(slide.getObjectId());
  properties.setProperty('pearcode_slides', JSON.stringify(markedSlides));
  
  // Add hidden marker (corrected transparency)
  const markerText = slide.insertTextBox('PEARCODE_SLIDE_MARKER', 0, 0, 1, 1);
  const textStyle = markerText.getText().getTextStyle();
  textStyle.setForegroundColor('#FFFFFF'); 
  textStyle.setFontSize(1);
}

function getTeacherView() {
  var joincode = generateJoinCode(); // A function that generates your 6-letter code.
  var template = HtmlService.createTemplateFromFile('TeacherView');
  template.joincode = joincode; // Pass the generated join code to the template.
  return template.evaluate().setTitle('Teacher View');
}

function generateJoinCode() {
  var letters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
  var code = '';
  for (var i = 0; i < 6; i++) {
    code += letters.charAt(Math.floor(Math.random() * letters.length));
  }
  return code;
}

function doGet(e) {
  // You can use query parameters to decide which page to show; here we'll assume TeacherView.
  return getTeacherView();
}

function startLesson() {
  // Load the teacher view HTML file from your project.
  var teacherView = HtmlService.createHtmlOutputFromFile('TeacherView')
    .setTitle('Teacher View')
    .setWidth(600); // Adjust width as needed
  
  // Display the teacher view in the Google Slides UI as a sidebar.
  SlidesApp.getUi().showSidebar(teacherView);
}
