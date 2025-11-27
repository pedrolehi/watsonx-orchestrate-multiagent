import { Test, TestingModule } from '@nestjs/testing';
import { BrokerWidgetService } from './broker-widget/broker-widget.service';
import { BrokerController } from './broker.controller';
import { BrokerService } from './broker.service';

describe('BrokerController', () => {
  let controller: BrokerController;
  let brokerService: jest.Mocked<BrokerService>;
  let brokerWidgetService: jest.Mocked<BrokerWidgetService>;

  beforeEach(async () => {
    const mockBrokerService = {
      processMessage: jest.fn(),
      getConversation: jest.fn(),
      createConversation: jest.fn(),
    };

    const mockBrokerWidgetService = {
      authenticateWidget: jest.fn(),
      processWidgetMessage: jest.fn(),
      getWidgetConversation: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      controllers: [BrokerController],
      providers: [
        {
          provide: BrokerService,
          useValue: mockBrokerService,
        },
        {
          provide: BrokerWidgetService,
          useValue: mockBrokerWidgetService,
        },
      ],
    }).compile();

    controller = module.get<BrokerController>(BrokerController);
    brokerService = module.get(BrokerService);
    brokerWidgetService = module.get(BrokerWidgetService);
  });

  describe('processMessage', () => {
    it('should process message and return response', async () => {
      const messageData = {
        message: 'Hello, how are you?',
        sessionId: 'test-session-id',
        assistantId: 'test-assistant-id',
      };

      const mockResponse = {
        response: 'Hello! I am doing well, thank you for asking.',
        sessionId: 'test-session-id',
        context: {},
      };

      brokerService.processMessage.mockResolvedValue(mockResponse);

      const result = await controller.processMessage(messageData);

      expect(brokerService.processMessage).toHaveBeenCalledWith(messageData);
      expect(result).toEqual(mockResponse);
    });

    it('should handle processing errors', async () => {
      const messageData = {
        message: 'Hello, how are you?',
        sessionId: 'test-session-id',
        assistantId: 'test-assistant-id',
      };

      const error = new Error('Processing failed');
      brokerService.processMessage.mockRejectedValue(error);

      await expect(controller.processMessage(messageData)).rejects.toThrow(
        'Processing failed',
      );
    });
  });

  describe('getConversation', () => {
    it('should get conversation by session id', async () => {
      const sessionId = 'test-session-id';
      const mockConversation = {
        sessionId,
        messages: [
          { role: 'user', content: 'Hello' },
          { role: 'assistant', content: 'Hi there!' },
        ],
        context: {},
      };

      brokerService.getConversation.mockResolvedValue(mockConversation);

      const result = await controller.getConversation(sessionId);

      expect(brokerService.getConversation).toHaveBeenCalledWith(sessionId);
      expect(result).toEqual(mockConversation);
    });

    it('should handle get conversation errors', async () => {
      const sessionId = 'test-session-id';
      const error = new Error('Get conversation failed');

      brokerService.getConversation.mockRejectedValue(error);

      await expect(controller.getConversation(sessionId)).rejects.toThrow(
        'Get conversation failed',
      );
    });
  });

  describe('createConversation', () => {
    it('should create new conversation', async () => {
      const conversationData = {
        assistantId: 'test-assistant-id',
        sessionId: 'test-session-id',
        context: {},
      };

      const mockCreatedConversation = {
        _id: 'conversation-id',
        ...conversationData,
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      brokerService.createConversation.mockResolvedValue(
        mockCreatedConversation,
      );

      const result = await controller.createConversation(conversationData);

      expect(brokerService.createConversation).toHaveBeenCalledWith(
        conversationData,
      );
      expect(result).toEqual(mockCreatedConversation);
    });

    it('should handle create conversation errors', async () => {
      const conversationData = {
        assistantId: 'test-assistant-id',
        sessionId: 'test-session-id',
        context: {},
      };

      const error = new Error('Create conversation failed');
      brokerService.createConversation.mockRejectedValue(error);

      await expect(
        controller.createConversation(conversationData),
      ).rejects.toThrow('Create conversation failed');
    });
  });

  describe('authenticateWidget', () => {
    it('should authenticate widget and return token', async () => {
      const authData = {
        widgetId: 'test-widget-id',
        secret: 'test-secret',
      };

      const mockAuthResponse = {
        token: 'widget-token-12345',
        expiresIn: 3600,
        widgetId: 'test-widget-id',
      };

      brokerWidgetService.authenticateWidget.mockResolvedValue(
        mockAuthResponse,
      );

      const result = await controller.authenticateWidget(authData);

      expect(brokerWidgetService.authenticateWidget).toHaveBeenCalledWith(
        authData,
      );
      expect(result).toEqual(mockAuthResponse);
    });

    it('should handle authentication errors', async () => {
      const authData = {
        widgetId: 'invalid-widget-id',
        secret: 'invalid-secret',
      };

      const error = new Error('Authentication failed');
      brokerWidgetService.authenticateWidget.mockRejectedValue(error);

      await expect(controller.authenticateWidget(authData)).rejects.toThrow(
        'Authentication failed',
      );
    });
  });

  describe('processWidgetMessage', () => {
    it('should process widget message and return response', async () => {
      const widgetMessageData = {
        message: 'Hello from widget',
        widgetId: 'test-widget-id',
        sessionId: 'widget-session-id',
      };

      const mockResponse = {
        response: 'Hello! How can I help you?',
        sessionId: 'widget-session-id',
        context: {},
      };

      brokerWidgetService.processWidgetMessage.mockResolvedValue(mockResponse);

      const result = await controller.processWidgetMessage(widgetMessageData);

      expect(brokerWidgetService.processWidgetMessage).toHaveBeenCalledWith(
        widgetMessageData,
      );
      expect(result).toEqual(mockResponse);
    });

    it('should handle widget message processing errors', async () => {
      const widgetMessageData = {
        message: 'Hello from widget',
        widgetId: 'test-widget-id',
        sessionId: 'widget-session-id',
      };

      const error = new Error('Widget message processing failed');
      brokerWidgetService.processWidgetMessage.mockRejectedValue(error);

      await expect(
        controller.processWidgetMessage(widgetMessageData),
      ).rejects.toThrow('Widget message processing failed');
    });
  });

  describe('getWidgetConversation', () => {
    it('should get widget conversation by session id', async () => {
      const sessionId = 'widget-session-id';
      const mockConversation = {
        sessionId,
        widgetId: 'test-widget-id',
        messages: [
          { role: 'user', content: 'Hello from widget' },
          { role: 'assistant', content: 'Hi there!' },
        ],
        context: {},
      };

      brokerWidgetService.getWidgetConversation.mockResolvedValue(
        mockConversation,
      );

      const result = await controller.getWidgetConversation(sessionId);

      expect(brokerWidgetService.getWidgetConversation).toHaveBeenCalledWith(
        sessionId,
      );
      expect(result).toEqual(mockConversation);
    });

    it('should handle get widget conversation errors', async () => {
      const sessionId = 'widget-session-id';
      const error = new Error('Get widget conversation failed');

      brokerWidgetService.getWidgetConversation.mockRejectedValue(error);

      await expect(controller.getWidgetConversation(sessionId)).rejects.toThrow(
        'Get widget conversation failed',
      );
    });
  });
});
